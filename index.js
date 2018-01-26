var config = require("./config.json");

var mqtt = require("mqtt");
// setup the mqtt client with port, host, and optional credentials 
var client = mqtt.connect(config.mqtt.url, {username: config.mqtt.username, password: config.mqtt.password});
const util = require("util");
const modbusAdress = 1;


var meterData = {};
var table = [];
//Name,                     hex reg,  size, signed, dec,    unit,     delta%
init("TOT Active Import",   0x5000,     4,  false,  100,    "kWh",      100);
init("L1 Active Import",    0x5460,     4,  false,  100,    "kWh",      100);
init("L2 Active Import",    0x5464,     4,  false,  100,    "kWh",      100);
init("L3 Active Import",    0x5468,     4,  false,  100,    "kWh",      100);
init("Power Fail Counter",  0x8A2F,     1,  false,  1,      "",         2);
//Instantaneus          
init("L1 Voltage",          0x5B00,     2,  false,  10,     "V",        4);
init("L2 Voltage",          0x5B02,     2,  false,  10,     "V",        4);
init("L3 Voltage",          0x5B04,     2,  false,  10,     "V",        4);
init("Frequency",           0x5B2C,     1,  false,  100,    "Hz",       4);
init("L1 Current",          0x5B0C,     2,  false,  100,    "A",        10);
init("L2 Current",          0x5B0E,     2,  false,  100,    "A",        10);
init("L3 Current",          0x5B10,     2,  false,  100,    "A",        10);
init("TOT Active Power",    0x5B14,     2,  true,   100,    "W",        10);
init("L1 Active Power",     0x5B16,     2,  true,   100,    "W",        40);
init("L2 Active Power",     0x5B18,     2,  true,   100,    "W",        40);
init("L3 Active Power",     0x5B1A,     2,  true,   100,    "W",        40);

const ModbusRTU = require("modbus-serial");
// create an empty modbus client
const meter = new ModbusRTU();

/*Configure rs484 Port*/

// open connection to a serial port
meter.connectRTUBuffered(config.rs485.port, {
    baudRate: config.rs485.baudRate,
    dataBits: config.rs485.dataBits,
    stopBits: config.rs485.stopBits,
    parity:   config.rs485.parity,
    autoOpen: config.rs485.autoOpen
});
// set timeout, if slave did not reply back
meter.setTimeout(config.rs485.timeout);

function nameToTopic(name) {
    return name.trim().replace(/ /g, "_");
}
function logObj(variable) {
	return JSON.stringify(variable, null, 4);
}
const publishMQTT = async (topic, data, delta = false) => {
    topic = nameToTopic(topic);
    if (delta) {
        publishTopic = config.mqtt.topicPrefix+topic+"/"+config.mqtt.deltaTopic.trim().replace(/\/\//g, "/");
        console.log("publishTopic: "+publishTopic)
        console.log("publishMessage: "+data)
    } else {
        publishTopic = config.mqtt.topicPrefix+topic.trim().replace(/\/\//g, "/");
    }
    await client.publish(publishTopic, data.toString())
}
const getMeterValues = async (values) => {
    try {
        // set ID of slave
        await meter.setID(config.rs485.modbusAdress);

        for(let value of values) {
            //Read data from meter
            let data = await getMeterValue(value.coil, value.size, value.signed, value.dec);
            if (!data) {
                //Something wrong with the data - keep last value and skip to next one!
                console.log("Skipping due to data: "+util.inspect(data))
                continue;
            }

            let topic = nameToTopic(value.name)
            // console.log(topic)
            // console.log("Value: "+meterData[topic].value)
            // console.log("First half: ("+meterData[topic].value+" - "+data+")/100 = "+(meterData[topic].value - data)/100)
            // console.log("Second half: "+data+" * ("+value.delta+"/100) = "+data*(value.delta/100))
            //console.log("Diff: "+(Math.abs((meterData[topic].value - data)/100)))
            if (!!meterData[topic].value && (Math.abs((meterData[topic].value/data))/100 >= value.delta/100)) {
                meterData[topic].value = data;
                publishMQTT(topic, JSON.stringify(meterData[topic]), true);
            } else {
                meterData[topic].value = data;
            }
            // wait 100ms before get another device
            await sleep(50);
		}
    } catch(e) {
        // if error, handle them here (it should not)
        publishMQTT("Error", util.inspect(e), false);
        return false;
    } finally {

        console.log(meterData);
        console.log("HELLO")

        for(let key of Object.keys(meterData)) {
            publishMQTT(meterData[key].name, JSON.stringify(meterData[key]), false);
        }

        await sleep(config.sampleTime);
        // after get all data from salve repeate it again
        setImmediate(() => {
            getMeterValues(table);
        })
    }
}

const getMeterValue = async (coil, size, signed, dec) => {
    try {	
    	let val = await meter.readHoldingRegisters(coil, size);
        if (size == 1) {
            let ret = (signed == true ? val.buffer.readInt16BE(0)/dec : val.buffer.readUInt16BE(0)/dec);//Hertz 1 size
            return ret;
        } else if(size == 2) {
            let ret = (signed == true ? val.buffer.readUInt32BE(0)/dec : val.buffer.readUInt32BE(0)/dec);
            return ret;
        } else if(size == 4) {
            let ret = (signed == true ? val.buffer.readInt32BE(size)/dec : val.buffer.readUInt32BE(size)/dec);;
            return ret
        } else {
            return false;
        }
    } catch(e){
        // if error return false
        publishMQTT("Error", "getMeterValue error: "+util.inspect(e), false);
        return false;
    } 
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function publish() {}

process.stdin.resume();//so the program will not close instantly

function exitHandler(options, err) {
    if (options.cleanup) {
        console.log("clean");
        meter.close();
    }
    if (err) console.log(err.stack);
    if (options.exit) process.exit();
}

//do something when app is closing
process.on("exit", exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on("SIGINT", exitHandler.bind(null, {exit:true}));

// catches "kill pid" (for example: nodemon restart)
process.on("SIGUSR1", exitHandler.bind(null, {exit:true}));
process.on("SIGUSR2", exitHandler.bind(null, {exit:true}));

//catches uncaught exceptions
process.on("uncaughtException", exitHandler.bind(null, {exit:true}));



function init(name, coil, size, signed, dec, unit, delta) {
    let map = {};

    map.name   = name;
    map.coil   = coil;
    map.size   = size;
    map.signed = signed;
    map.dec    = dec;
    map.unit   = unit;
    map.delta  = delta;

    table.push(map);

    let topic = nameToTopic(name);
    console.log(topic)
    meterData[topic] = {};
    meterData[topic].name  = name;
    meterData[topic].value = null;
    meterData[topic].unit  = unit;

}


console.log("Table: "+util.inspect(table, false, null))


// start get value
getMeterValues(table);