import express from 'express';
import bodyParser from 'body-parser';
//import { Sequelize, Model, DataTypes } from 'sequelize';
import { InfluxDB, Point } from '@influxdata/influxdb-client';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

/*const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite'
});*/

const url = process.env.INFLUX_URL || '';
const token = process.env.INFLUX_TOKEN || '';
const org = process.env.INFLUX_ORG || '';
const bucket = process.env.INFLUX_BUCKET || '';

const queryApi = new InfluxDB({url, token}).getQueryApi(org);

/*class User extends Model {}
User.init({
    name: DataTypes.STRING,
    email: DataTypes.STRING,
    password: DataTypes.STRING
}, { sequelize, modelName: 'user' });

sequelize.sync();*/
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/*app.get('/users', async (req, res) => {
    const users = await User.findAll();
    res.json(users);
});

app.get('/users/:id', async (req, res) => {
    const user = await User.findByPk(req.params.id);
    res.json(user);
});

app.post('/users', async (req, res) => {
    const user = await User.create(req.body);
    res.json(user);
});

app.put('/users/:id', async (req, res) => {
    const user = await User.findByPk(req.params.id);
    if (user) {
        await user.update(req.body);
        res.json(user);
    } else {
        res.status(404).json({ message: 'User not found' });
    }
});

app.delete('/users/:id', async (req, res) => {
    const user = await User.findByPk(req.params.id);
    if (user) {
        await user.destroy();
        res.json({ message: 'User deleted' });
    } else {
        res.status(404).json({ message: 'User not found' });
    }
});*/

function isSystemMetric(measurement) {
    const systemPrefixes = [
        'go_', 'http_', 'influxdb_', 'qc_', 'service_', 
        'storage_', 'task_', 'boltdb_', 'query_'
    ];
    return systemPrefixes.some(prefix => measurement.startsWith(prefix));
}

app.get('/online-nodes', async (req, res) => {
    try {
        const fluxQuery = `
            import "influxdata/influxdb/schema"

            schema.measurements(bucket: "${bucket}")
        `;

        const measurements = [];

        for await (const {values, tableMeta} of queryApi.iterateRows(fluxQuery)) {
            const measurement = tableMeta.toObject(values)._value;
            if (!isSystemMetric(measurement)) {
                measurements.push(measurement);
            }
        }

        res.json({ measurements });
    } catch (error) {
        console.error('Error querying measurements:', error);
        res.status(500).json({ 
            error: 'Failed to fetch measurements',
            message: error.message 
        });
    }
});

const server = app.listen(port, () => {
    console.log(`Smart Garden API listening on port ${port}`);
});

const shutdown = (signal) => {
    console.log(`${signal} signal received: closing HTTP server`);
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
