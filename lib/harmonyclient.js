var debug = require('debug')('harmonyhubjs:client:harmonyclient')
	, Q = require('q')
	, xmppUtil = require('./util')
	, util = require('util')
	, EventEmitter = require('events').EventEmitter;


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

function getCurrentActivity() {
	debug('retrieve current activity');

	return this.sendCommand('getCurrentActivity')
	.then(function(response) {
		var result = response.result;
		return result;
	});
}

function getActivities() {
	debug('retrieve activities');

	return this.getAvailableCommands()
	.then(function(availableCommands) {
		return availableCommands.activity;
	});
}

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

		console.log('start activity ' + body);

	return this.sendCommand('startactivity', body, 'encoded', function(stanza) {
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

function turnOff() {
	debug('turn off');
	return this.startActivity(-1);
}

function isOff() {
	debug('check if turned off');

	return this.getCurrentActivity()
	.then(function(activityId) {
		var off = (activityId === '-1');
		debug(off ? 'system is currently off' : 'system is currently on with activity ' + activityId);

		return off;
	});
}

function getAvailableCommands() {
	debug('retrieve available commands');

	return this.sendCommand('config', undefined, 'json')
	.then(function(response) {
		return response;
	});
}

function defaultCanHandleStanzaFn(awaitedId, stanza) {
	var stanzaId = stanza.attr('id');
	return (stanzaId && stanzaId == awaitedId);
}

function sendCommand(command, body, expectedResponseType, canHandleStanzaFn) {
	debug('send command ' + command);

	var deferred = Q.defer()
		, iq = xmppUtil.buildIqStanza(
			'get'
			, 'connect.logitech.com'
			, 'vnd.logitech.harmony/vnd.logitech.harmony.engine?' + command
			, body
		)
		, id = iq.attr('id');
	
	expectedResponseType = expectedResponseType || 'encoded';
	canHandleStanzaFn = canHandleStanzaFn || defaultCanHandleStanzaFn.bind(null, id);

	this._responseHandlerQueue.push({
		canHandleStanza: canHandleStanzaFn
		, deferred: deferred
		, responseType: expectedResponseType
	});

	this._xmppClient.send(iq);

	return deferred.promise;
}

function end() {
	debug('close harmony client');
	this._xmppClient.end();
}


HarmonyClient.prototype.isOff = isOff;
HarmonyClient.prototype.turnOff = turnOff;
HarmonyClient.prototype.getActivities = getActivities;
HarmonyClient.prototype.getCurrentActivity = getCurrentActivity;
HarmonyClient.prototype.startActivity = startActivity;
HarmonyClient.prototype.getDevices = getDevices;
HarmonyClient.prototype.executeDeviceCommand = executeDeviceCommand;

HarmonyClient.prototype.getAvailableCommands = getAvailableCommands;
HarmonyClient.prototype.sendCommand = sendCommand;

HarmonyClient.prototype.end = end;

module.exports = HarmonyClient;
