/*
 * Copyright 2016 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of iotagent-ul
 *
 * iotagent-ul is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * iotagent-ul is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with iotagent-ul.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[iot_support@tid.es]
 *
 * Modified by: Fernando Méndez, Daniel Calvo - ATOS Research & Innovation
 */

'use strict';

var iotAgentLib = require('iotagent-node-lib'),
    config = require('./configService'),
    intoTrans = iotAgentLib.intoTrans,
    _ = require('underscore'),
    utils = require('./iotaUtils'),
    async = require('async'),
    ulParser = require('./ulParser'),
    constants = require('./constants'),
    context = {
        op: 'IOTAUL.Common.Binding'
    };

/**
 * Find the attribute given by its name between all the active attributes of the given device, returning its type, or
 * null otherwise.
 *
 * @param {String} attribute        Name of the attribute to find.
 * @param {Object} device           Device object containing all the information about a device.
 * @return {String}                 String identifier of the attribute type.
 */
function guessType(attribute, device) {
    for (var i = 0; i < device.active.length; i++) {
        if (device.active[i].name === attribute) {
            return device.active[i].type;
        }
    }

    if (attribute === constants.TIMESTAMP_ATTRIBUTE) {
        if (iotAgentLib.configModule.checkNgsi2()) {
            return constants.TIMESTAMP_TYPE_NGSI2;
        }
        else {
            return constants.TIMESTAMP_TYPE;
        }
    } else {
        return constants.DEFAULT_ATTRIBUTE_TYPE;
    }
}

/**
 * Utility function used to reduce UL Payload group arrays and process them to update their value in the Context Broker.
 * This function process a new element of the payload group, generating a function ready to be called with a callback
 * in a async.series() call.
 *
 * @param {Object} device       Object containing all the information about the device sending the measures.
 * @param {String} apikey       APIKey of the service the device belongs to.
 * @param {Array} previous      Array of prepared functions that send information to the Context Broker.
 * @param {Object} current      Information sent by the device.
 * @param {Number} index        Index of the group in the array.
 * @return {Array}             Updated array of functions.
 */
function processMeasureGroup(device, apikey, previous, current, index) {
    var values = [];

    if (current.command) {
        previous.push(iotAgentLib.setCommandResult.bind(null,
            device.name,
            config.getConfig().iota.defaultResource,
            apikey,
            current.command,
            current.value,
            constants.COMMAND_STATUS_COMPLETED,
            device
        ));
    } else {
        for (var i in current) {
            if (current.hasOwnProperty(i)) {
                values.push({
                    name: i,
                    type: guessType(i, device),
                    value: current[i]
                });
            }
        }

        previous.push(iotAgentLib.update.bind(null, device.name, device.type, '', values, device));
    }

    return previous;
}


/**
 * Adds multiple MQTT measures to the Context Broker. Multiple measures come in the form of single-level JSON objects,
 * whose keys are the attribute names and whose values are the attribute values.
 *
 * @param {String} apiKey           API Key corresponding to the Devices configuration.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {String} message          UL payload.
 */
function multipleMeasures(apiKey, device, message) {
    var updates = [],
        messageStr = message.toString(),
        parsedMessage;

    config.getLogger().debug('Processing multiple measures for device [%s] with apiKey [%s]', device.id, apiKey);

    try {
        parsedMessage = ulParser.parse(messageStr);
    } catch (e) {
        config.getLogger().error(context, 'MEASURES-003: Parse error parsing incoming MQTT message [%]', messageStr);
        return;
    }

    updates = parsedMessage.reduce(processMeasureGroup.bind(null, device, apiKey), []);

    async.series(updates, function(error) {
        if (error) {
            config.getLogger().error(context,
                ' MEASURES-002: Couldn\'t send the updated values to the Context Broker due to an error: %s', error);
        } else {
            config.getLogger().debug(context, 'Multiple measures for device [%s] with apiKey [%s] successfully updated',
                device.id, apiKey);
        }
    });
}

/**
 * Adds a single MQTT measure to the context broker. The message for single measures contains the direct value to
 * be inserted in the attribute, given by its name.
 *
 * @param {String} apiKey           API Key corresponding to the Devices configuration.
 * @param {String} attribute        Name of the attribute to update.
 * @param {Object} device           Device object containing all the information about a device.
 * @param {Buffer} message          Raw message coming from the MQTT client.
 */
function singleMeasure(apiKey, attribute, device, message) {
    var values;

    config.getLogger().debug('Processing single measure for device [%s] with apiKey [%s]', device.id, apiKey);

    values = [
        {
            name: attribute,
            type: guessType(attribute, device),
            value: message.toString()
        }
    ];

    iotAgentLib.update(device.name, device.type, '', values, device, function(error) {
        if (error) {
            config.getLogger().error(context,
                ' MEASURES-002: Couldn\'t send the updated values to the Context Broker due to an error: %s', error);
        } else {
            config.getLogger().debug(context, 'Single measure for device [%s] with apiKey [%s] successfully updated',
                device.id, apiKey);
        }
    });
}

/**
 * Handles an incoming MQTT message, extracting the API Key, device Id and attribute to update (in the case of single
 * measures) from the MQTT topic.
 *
 * @param {String} topic        Topic of the form: '/<APIKey>/deviceId/attributes[/<attributeName>]'.
 * @param {Object} message      MQTT message body (Object or Buffer, depending on the value).
 */
function messageHandler(topic, message) {
    var topicInformation = topic.split('/'),
        apiKey = topicInformation[1],
        deviceId = topicInformation[2];

    function processMessageForDevice(device, apiKey, topicInformation) {
        if (topicInformation[4]) {
            singleMeasure(apiKey, topicInformation[4], device, message);
        } else {
            iotAgentLib.alarms.release(constants.MQTTB_ALARM);

            if (topicInformation[3] === constants.CONFIGURATION_COMMAND_SUFIX) {
                var commandObj = ulParser.result(message.toString());
                utils.updateCommand(
                    apiKey,
                    device,
                    commandObj.result,
                    commandObj.command,
                    constants.COMMAND_STATUS_COMPLETED,
                    function(error) {
                        config.getLogger().debug('Command updated with result: %s', error);
                    });
            } else if (topicInformation[3] === constants.MEASURES_SUFIX) {
                multipleMeasures(apiKey, device, message.toString());
            } else {
                config.getLogger().error(context,
                    'MEASURES-004: Couldn\'t process message [%s] due to format issues.', message);
            }
        }
    }

    function processDeviceMeasure(error, device) {
        if (error) {
            config.getLogger().error(context, 'MEASURES-005: Error before processing device measures [%s]', topic);
        } else {
            var localContext = _.clone(context);

            localContext.service = device.service;
            localContext.subservice = device.subservice;

            intoTrans(localContext, processMessageForDevice)(device, apiKey, topicInformation);
        }
    }

    utils.retrieveDevice(deviceId, apiKey, 'MQTT', processDeviceMeasure);
}

exports.messageHandler = messageHandler;
exports.processMeasureGroup = processMeasureGroup;
exports.guessType = guessType;
