var debug = require('debug')('harmonyhubjs:client:harmonyclient')
	, Q = require('q')
	, xmppUtil = require('./util')
	, util = require('util')
	, EventEmitter = require('events').EventEmitter;

/**
 * Creates a new HarmonyClient using the given xmppClient to communication.
 *
 * @param xmppClient
 * @constructor
 */
function HarmonyClient(xmppClient) {
	debug('create new harmony client');

	var self = this;

	self._xmppClient = xmppClient;
	self._responseHandlerQueue = [];

	function handleStanza(stanza) {
		debug('handleStanza(' + stanza.toString() + ')');

		// Check for state digest:
		var event = stanza.getChild('event');
		if(event && event.attr('type') === 'connect.stateDigest?notify') {
			onStateDigest.call(self, JSON.parse(event.getText()));
		}

		// Check for queued response handlers:
		self._responseHandlerQueue.forEach(function(responseHandler, index, array) {
			if(responseHandler.canHandleStanza(stanza)) {
				debug('received response stanza for queued response handler');

				var response = stanza.getChildText('oa')
					, decodedResponse;

				if(responseHandler.responseType === 'json') {
					decodedResponse = JSON.parse(response);
				} else {
					decodedResponse = xmppUtil.decodeColonSeparatedResponse(response);
				}

				responseHandler.deferred.resolve(decodedResponse);
				array.splice(index, 1);
			}
		});
	}

	xmppClient.on('stanza', handleStanza.bind(self));
	EventEmitter.call(this);
}
util.inherits(HarmonyClient, EventEmitter);

function onStateDigest(stateDigest) {
	debug('received state digest');
	this.emit('stateDigest', stateDigest);
}

/**
 * Returns the latest turned on activity from a hub.
 *
 * @returns {Q.Promise}
 */
function getCurrentActivity() {
	debug('retrieve current activity');

	return this.request('getCurrentActivity')
	.then(function(response) {
		var result = response.result;
		return result;
	});
}

/**
 * Retrieves a list with all available activities.
 *
 * @returns {Q.Promise}
 */
function getActivities() {
	debug('retrieve activities');

	return this.getAvailableCommands()
	.then(function(availableCommands) {
		return availableCommands.activity;
	});
}

/**
 * Starts an activity with the given id.
 *
 * @param activityId
 * @returns {Q.Promise}
 */
function getDevices() {
	debug('retrieve commands');
	return this.getAvailableCommands()
	.then(function(availableCommands) {
		return availableCommands.device;
	})
}

function executeDeviceCommand(type, deviceId, command) {

	var body = 'action={\"type\"::\"' + type + '\",\"deviceId\"::\"' + deviceId + '\",\"command\"::\"' + command + '\"}:status=press';

	//console.log('start device_command: ' + body);

	return this.sendCommand('holdAction', body, 'encoded', function(stanza) {
	});
}

function startActivity(activityId) {

	var timestamp = new Date().getTime()
		, body = 'activityId=' + activityId + ':timestamp=' + timestamp;

	return this.request('startactivity', body, 'encoded', function(stanza) {
		// This canHandleStanzaFn waits for a stanza that confirms starting the activity.
		// It looks something like this:
		//
		// <message from="HarmonyOne_Pop@qa1.com" to="ab903454-7bee-4410-9eea-bb5355bb667e">
		//     <event xmlns="connect.logitech.com" type="harmony.engine?startActivityFinished"><![CDATA[activityId=7596992:errorCode=200:errorString=OK]]></event>
		// </message>
		var event = stanza.getChild('event')
			, canHandleStanza = false;

		if(event && event.attr('type') === 'harmony.engine?startActivityFinished') {
			var decodedResponse = xmppUtil.decodeColonSeparatedResponse(event.getText());

			if(decodedResponse.activityId === activityId) {
				debug('got notification that activity ' + activityId + ' started successfully');
				canHandleStanza = true;
			}
		}

		return canHandleStanza;
	});
}

/**
 * Turns the currently running activity off. This is implemented by "starting" an imaginary activity with the id -1.
 *
 * @returns {Q.Promise}
 */
function turnOff() {
	debug('turn off');
	return this.startActivity('-1');
}

/**
 * Checks if the hub has now activity turned on. This is implemented by checking the hubs current activity. If the
 * activities id is equal to -1, no activity is on currently.
 *
 * @returns {Q.Promise}
 */
function isOff() {
	debug('check if turned off');

	return this.getCurrentActivity()
	.then(function(activityId) {
		var off = (activityId === '-1');
		debug(off ? 'system is currently off' : 'system is currently on with activity ' + activityId);

		return off;
	});
}

/**
 * Acquires all available commands from the hub when resolving the returned promise.
 *
 * @returns {Q.Promise}
 */
function getAvailableCommands() {
	debug('retrieve available commands');

	return this.request('config', undefined, 'json')
	.then(function(response) {
		return response;
	});
}

/**
 * Builds an IQ stanza containing a specific command with given body, ready to send to the hub.
 *
 * @param command
 * @param body
 * @returns {Stanza}
 */
function buildCommandIqStanza(command, body) {
	debug('buildCommandIqStanza for command "' + command + '" with body ' + body);

	return xmppUtil.buildIqStanza(
		'get'
		, 'connect.logitech.com'
		, 'vnd.logitech.harmony/vnd.logitech.harmony.engine?' + command
		, body
	);
}

function defaultCanHandleStanzaPredicate(awaitedId, stanza) {
	var stanzaId = stanza.attr('id');
	return (stanzaId && stanzaId == awaitedId);
}

/**
 * Sends a command with the given body to the hub. The returned promise gets resolved as soon as a response for this
 * very request arrives.
 *
 * By specifying expectedResponseType with either "json" or "encoded", you advice the response stanza handler how you
 * expect the responses data encoding. See the protocol guide for further information.
 *
 * The cnaHandleStanzaFn parameter allows to define a predicate to determine if an incoming stanza is the response to
 * your request. This can be handy if a generic stateDigest message might be the acknowledgment to your initial
 * request.
 * *
 * @param command
 * @param body
 * @param expectedResponseType
 * @param canHandleStanzaPredicate
 * @returns {Q.Promise}
 */
function request(command, body, expectedResponseType, canHandleStanzaPredicate) {
	debug('request with command "' + command + '" with body ' + body);

	var deferred = Q.defer()
		, iq = buildCommandIqStanza(command, body)
		, id = iq.attr('id');
	
	expectedResponseType = expectedResponseType || 'encoded';
	canHandleStanzaPredicate = canHandleStanzaPredicate || defaultCanHandleStanzaPredicate.bind(null, id);

	this._responseHandlerQueue.push({
		canHandleStanza: canHandleStanzaPredicate
		, deferred: deferred
		, responseType: expectedResponseType
	});

	this._xmppClient.send(iq);

	return deferred.promise;
}

/**
 * Sends a command with given body to the hub. The returned promise gets immediately resolved since this function does
 * not expect any specific response from the hub.
 *
 * @param command
 * @param body
 * @returns {Q.Promise}
 */
function send(command, body) {
	debug('send command "' + command + '" with body ' + body);
	this._xmppClient.send(buildCommandIqStanza(command, body));
	return Q();
}

/**
 * Closes the connection the the hub. You have to create a new client if you would like to communicate again with the
 * hub.
 */
function end() {
	debug('close harmony client');
	this._xmppClient.end();
	return Q();
}


HarmonyClient.prototype.isOff = isOff;
HarmonyClient.prototype.turnOff = turnOff;
HarmonyClient.prototype.getActivities = getActivities;
HarmonyClient.prototype.getCurrentActivity = getCurrentActivity;
HarmonyClient.prototype.startActivity = startActivity;
HarmonyClient.prototype.getDevices = getDevices;
HarmonyClient.prototype.executeDeviceCommand = executeDeviceCommand;

HarmonyClient.prototype.getAvailableCommands = getAvailableCommands;
HarmonyClient.prototype.request = request;
HarmonyClient.prototype.send = send;

HarmonyClient.prototype.end = end;

module.exports = HarmonyClient;
