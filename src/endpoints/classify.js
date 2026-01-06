import express from 'express';
import crypto from 'node:crypto';

import { getPipeline } from '../transformers.js';
import { BoundedCache, getConfigValue } from '../util.js';

const TASK = 'text-classification';

export const router = express.Router();

/**
 * Cache for classification results.
 * Bounded to avoid unbounded memory growth / DoS via unique inputs.
 */
const cacheObject = new BoundedCache({
    ttlMs: getConfigValue('performance.classifyCacheTtlMs', 24 * 60 * 60 * 1000, 'number'),
    maxEntries: getConfigValue('performance.classifyCacheMaxEntries', 5000, 'number'),
});

router.post('/labels', async (req, res) => {
    try {
        const pipe = await getPipeline(TASK);
        const result = Object.keys(pipe.model.config.label2id);
        return res.json({ labels: result });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.post('/', async (req, res) => {
    try {
        const { text } = req.body;

        /**
         * Get classification result for a given text
         * @param {string} text Text to classify
         * @returns {Promise<object>} Classification result
         */
        async function getResult(text) {
            const cacheKey = crypto.createHash('sha256').update(text).digest('hex');
            const cached = cacheObject.get(cacheKey);
            if (cached) {
                return cached;
            }

            const pipe = await getPipeline(TASK);
            const result = await pipe(text, { topk: 5 });
            result.sort((a, b) => b.score - a.score);
            cacheObject.set(cacheKey, result);
            return result;
        }

        console.debug('Classify input:', text);
        const result = await getResult(text);
        console.debug('Classify output:', result);

        return res.json({ classification: result });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});
