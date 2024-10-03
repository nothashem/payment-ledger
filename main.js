const express = require('express');
const mongoose = require('mongoose');
const EventEmitter = require('events');
const ledger = require('./ledger');

const events = new EventEmitter();

// Use the PORT environment variable provided by Heroku
const port = process.env.PORT || 3000;

// Connection URL
const uri = "/";

const app = express();  

async function main() {
    try {
        // Move this line here
        app.use(express.json());
        
        await mongoose.connect(uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 3000000, 
            socketTimeoutMS: 3000000, 
        });
        console.log('Connected successfully to server');

        events.on('someEvent', (event) => {
            console.log('someEvent was triggered');
            mongoose.connection.db.collection('events').insertOne(event, (err, result) => {
                if (err) {
                    console.error('Error storing event:', err);
                } else {
                    console.log('Event stored successfully:', result.insertedId);
                }
            });
        });

        app.use('/api', ledger);

        app.get('/', (req, res) => {
            res.send('Hello World!');
        });

        app.listen(port, '0.0.0.0', () => {
            console.log(`Example app listening at http://localhost:${port}`);
        });
    } catch (err) {
        console.error("Error:", err);
    }
}

main().catch(console.error);