const express = require('express');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const eventEmitter = new EventEmitter();

const app = express();
app.use(express.json());

const events = [];



module.exports = eventEmitter;
