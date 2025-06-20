import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { Sequelize, Model, DataTypes } from 'sequelize';
import { InfluxDB } from '@influxdata/influxdb-client';
import dotenv from 'dotenv';
import { isSystemMetric, moistureToPercentage } from './helpers.js';
import multer from 'multer';
import path from 'path';
import webpush from 'web-push';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

webpush.setVapidDetails(
    'mailto:test@test.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
)

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: './database.sqlite'
});

const url = process.env.INFLUX_URL || '';
const token = process.env.INFLUX_TOKEN || '';
const org = process.env.INFLUX_ORG || '';
const bucket = process.env.INFLUX_BUCKET || '';

const queryApi = new InfluxDB({ url, token }).getQueryApi(org);

class Config extends Model { }
Config.init({
    id: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        unique: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false
    },
    version: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    interval: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    led_state: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
    },
    imagePath: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    soilMoistureThreshold: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
}, { sequelize, modelName: 'config' });

class Subscription extends Model { }
Subscription.init({
    id: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        unique: true,
    },
    data: {
        type: DataTypes.STRING,
        allowNull: false
    },
    lastSent: {
        type: DataTypes.DATE,
    },
}, { sequelize, modelName: 'subscription' });

sequelize.sync();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(cors({
    origin: ['https://smart-garden.traaga.ee'],
    credentials: true
}));

app.use('/uploads', (req, res, next) => {
    console.log('req.path', req.path);
    res.header('Access-Control-Allow-Origin', 'https://smart-garden.traaga.ee');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
}, express.static('public/uploads/*'));

app.use(express.static('public'));

const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5 MB limit
});

app.get('/online-nodes', async (req, res) => {
    try {
        const fluxQuery = `
            import "influxdata/influxdb/schema"

            schema.measurements(bucket: "${bucket}")
        `;

        const measurements = [];

        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
            const measurement = tableMeta.toObject(values)._value;
            if (!isSystemMetric(measurement)) {
                measurements.push(measurement);
            }
        }

        const results = [];

        // Process each measurement one at a time instead of joining them
        for (const measurement of measurements) {
            const latestDataQuery = `
                from(bucket: "${bucket}")
                    |> range(start: -48h)
                    |> filter(fn: (r) => r._measurement == "${measurement}")
                    |> last()
            `;

            for await (const { values, tableMeta } of queryApi.iterateRows(latestDataQuery)) {
                const row = tableMeta.toObject(values);
                const id = row._measurement;

                // Find existing entry or create new one
                let entry = results.find(r => r.id === id);
                if (!entry) {
                    entry = {
                        id: id,
                        fields: {}
                    };
                    results.push(entry);
                }

                entry.fields[row._field] = row._value;

                if (entry.fields.moisture) {
                    entry.fields.moisture = moistureToPercentage(entry.fields.moisture);
                }
            }
        }

        // Fetch configuration data for all entries
        for (const entry of results) {
            try {
                const item = await Config.findOne({
                    where: {
                        id: entry.id,
                    }
                });

                let showWarning = false;
                if (item && item.soilMoistureThreshold && entry.fields.moisture) {
                    showWarning = item.soilMoistureThreshold >= entry.fields.moisture;
                }

                if (item) {
                    entry.name = item.name;
                    entry.imageUrl = item.imagePath ? `${process.env.API_DOMAIN}${item.imagePath}` : null;
                    entry.showWarning = showWarning;
                } else {
                    console.error('Config not found:', entry.id);
                }
            } catch (error) {
                console.error('Error fetching config:', error);
            }
        }

        res.json(results);
    } catch (error) {
        console.error('Error querying online nodes:', error);
        res.status(500).json({
            error: 'Failed to fetch online nodes',
            message: error.message
        });
    }
});

app.get('/config', async (req, res) => {
    const { id } = req.query;

    if (!id || id.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid or missing ID parameter'
        });
    }

    try {
        const item = await Config.findByPk(id.trim());

        if (!item) {
            return res.status(404).json({
                error: 'Config not found'
            });
        }

        const { imagePath, ...rest } = item.dataValues;

        const response = {
            imageUrl: imagePath ? `${process.env.API_DOMAIN}${imagePath}` : null,
            ...rest,
        }

        res.json(response);
    } catch (error) {
        console.error('Error fetching config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Saves new config to sqllite
app.put('/config', async (req, res) => {
    const { id } = req.query;


    if (!id || id.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid or missing ID parameter'
        });
    }

    if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({
            error: 'Config in body must be a valid JSON object'
        });
    }

    try {
        const [item, created] = await Config.findOrCreate({
            where: { id: id.trim() },
            defaults: req.body,
        });

        if (!created) {
            // Config was found -> updating it.

            if (item.interval != req.body.interval || item.led_state != req.body.led_state) {
                item.version += 1;
            }

            item.name = req.body.name;
            item.interval = req.body.interval;
            item.led_state = req.body.led_state;
            item.soilMoistureThreshold = req.body.soilMoistureThreshold;

            await item.save();
            return res.status(204).send();
        }

        res.status(201).send();
    } catch (error) {
        console.error('Error handling config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/current-measurements', async (req, res) => {
    const { id } = req.query;

    if (!id || id.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid or missing id parameter'
        });
    }

    try {
        const fluxQuery = `
            from(bucket: "${bucket}")
                |> range(start: -48h)
                |> filter(fn: (r) => r._measurement == "${id}")
                |> last()
        `;

        const result = {};

        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
            const row = tableMeta.toObject(values);

            result[row._field] = row._value;

            if (row._field === 'moisture') {
                result.moisture = moistureToPercentage(result.moisture);
            }
        }

        if (Object.keys(result).length === 0) {
            return res.status(404).json({
                error: 'No measurements found for the specified ID: ' + id,
            });
        }

        res.json(result);
    } catch (error) {
        console.error('Error querying current measurements:', error);
        res.status(500).json({
            error: 'Failed to fetch current measurements',
            message: error.message
        });
    }
});

app.get('/history-measurements', async (req, res) => {
    const { id } = req.query;

    if (!id || id.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid or missing id parameter'
        });
    }

    try {
        const fluxQueryDay = `
            from(bucket: "${bucket}")
                |> range(start: -24h)
                |> filter(fn: (r) => r["_measurement"] == "${id}")
                |> aggregateWindow(every: 15m, fn: median, createEmpty: false)
                |> yield(name: "median")
        `;

        const fluxQueryWeek = `
            from(bucket: "${bucket}")
                |> range(start: -7d)
                |> filter(fn: (r) => r["_measurement"] == "${id}")
                |> aggregateWindow(every: 6h, fn: median, createEmpty: false)
                |> yield(name: "median")
        `;

        const fluxQueryMonth = `
            from(bucket: "${bucket}")
                |> range(start: -30d)
                |> filter(fn: (r) => r["_measurement"] == "${id}")
                |> aggregateWindow(every: 6h, fn: median, createEmpty: false)
                |> yield(name: "median")
        `;

        const measurements = {
            day: [],
            week: [],
            month: []
        };

        // -------------------- DAY ----------------------
        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryDay)) {
            const row = tableMeta.toObject(values);

            const result = {
                datetime: row._time
            };
            result[row._field] = row._value;

            if (row._field === 'moisture') {
                result.moisture = moistureToPercentage(result.moisture);
            }

            measurements.day.push(result);
        }

        // --------------------- WEEK -------------------------
        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryWeek)) {
            const row = tableMeta.toObject(values);

            const result = {
                datetime: row._time
            };
            result[row._field] = row._value;

            if (row._field === 'moisture') {
                result.moisture = moistureToPercentage(result.moisture);
            }

            measurements.week.push(result);
        }

        // --------------------- MONTH ----------------------------
        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQueryMonth)) {
            const row = tableMeta.toObject(values);

            const result = {
                datetime: row._time
            };
            result[row._field] = row._value;

            if (row._field === 'moisture') {
                result.moisture = moistureToPercentage(result.moisture);
            }

            measurements.month.push(result);
        }

        res.json(measurements);
    } catch (error) {
        console.error('Error querying history measurements:', error);
        res.status(500).json({
            error: 'Failed to fetch history measurements',
            message: error.message
        });
    }
});

app.post('/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file || !req.body.id) {
            return res.status(400).json({ error: 'No file uploaded or no id provided' });
        }

        const imagePath = `/uploads/${req.file.filename}`;

        const config = await Config.findByPk(req.body.id);
        if (config) {
            config.imagePath = imagePath;
            await config.save();
        }

        res.status(200).json({ imagePath });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

app.get('/subscription', async (req, res) => {
    const { nodeId } = req.query;

    if (!nodeId || nodeId.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid or missing node ID parameter'
        });
    }

    try {
        const fluxQuery = `
            from(bucket: "${bucket}")
                |> range(start: -48h)
                |> filter(fn: (r) => r._measurement == "${nodeId}")
                |> last()
        `;

        const result = {};

        for await (const { values, tableMeta } of queryApi.iterateRows(fluxQuery)) {
            const row = tableMeta.toObject(values);

            result[row._field] = row._value;

            if (row._field === 'moisture') {
                result.moisture = moistureToPercentage(result.moisture);
            }
        }

        const config = await Config.findByPk(nodeId.trim());

        if (!config) {
            return res.status(404).json({
                error: 'Config not found'
            });
        }

        let thresholdsReached = false;
        let message = {
            title: config.name,
            body: '',
            icon: '/icon.svg',
        };

        if (config.soilMoistureThreshold && result.moisture > 5 && result.moisture <= config.soilMoistureThreshold) {
            thresholdsReached = true;
            message.body = 'Water me, please! 🌱';
        }

        res.status(200).send({
            thresholdsReached,
            message,
        });
    } catch (error) {
        console.error('Error checking thresholds:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/subscription', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || !req.body.id || !req.body.data) {
        return res.status(400).json({
            error: 'Invalid payload'
        });
    }

    try {
        const [item, created] = await Subscription.findOrCreate({
            where: { id: req.body.id.trim() },
            defaults: req.body,
        });

        if (!created) {
            // Subscription was found -> updating it.

            item.data = req.body.data;

            await item.save();
            return res.status(204).send();
        }

        res.status(201).send();
    } catch (error) {
        console.error('Error handling config:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/subscription', async (req, res) => {
    const { id } = req.query;

    if (!id || id.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid or missing ID parameter'
        });
    }

    try {
        const deletedCount = await Subscription.destroy({
            where: { id: id.trim() }
        });

        if (deletedCount === 0) {
            return res.status(404).json({
                error: 'Subscription not found'
            });
        }

        res.status(204).send();
    } catch (error) {
        console.error('Error deleting subscription:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/subscription', async (req, res) => {
    const { ids, message } = req.body;

    if (!ids || !Array.isArray(ids)) {
        return res.status(400).json({
            error: 'Invalid or missing IDs parameter'
        });
    }

    if (!message || typeof message !== 'object') {
        return res.status(400).json({
            error: 'Invalid or missing message parameter'
        });
    }

    try {
        let subscriptions;

        if (ids && Array.isArray(ids) && ids.length > 0) {
            subscriptions = await Subscription.findAll({
                where: { id: ids }
            });
        } else {
            subscriptions = await Subscription.findAll();
        }

        if (subscriptions.length === 0) {
            return res.status(404).json({ error: 'No subscriptions found' });
        }

        await Promise.all(
            subscriptions.map(async (subscription) => {
                const waitPeriodInSeconds = 3 * 3600; // 3h
                const lastSentInSeconds = subscription.lastSent ? subscription.lastSent.getTime() : 0;
                const secondsSinceLastSend = (Date.now() - lastSentInSeconds) / 1000;

                if (secondsSinceLastSend < waitPeriodInSeconds) {
                    return;
                }

                try {
                    const subscriptionData = JSON.parse(subscription.data);
                    await webpush.sendNotification(
                        subscriptionData,
                        JSON.stringify(message)
                    );

                    subscription.lastSent = Date.now();
                    await subscription.save();
                } catch (error) {
                    console.error(`Error sending notification to ${subscription.id}:`, error);
                }
            })
        );

        res.status(200).send();
    } catch (error) {
        console.error('Error processing subscriptions:', error);
        res.status(500).json({ error: 'Internal server error' });
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
