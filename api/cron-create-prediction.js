#!/usr/bin/env node
/**
 * Vercel Cron Handler for Auto-Creating Ink Chain Predictions
 * 
 * This is a Vercel serverless function that can be triggered by Vercel Cron.
 * It creates new Ink Chain predictions based on templates.
 * 
 * Deploy this as a Vercel function and configure cron in vercel.json
 */

const { loadTemplates, createPrediction } = require('./auto-create-ink-predictions');

module.exports = async (req, res) => {
    try {
        // Verify this is a cron request from Vercel
        if (req.headers['x-vercel-cron'] !== '1') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized - Not a Vercel cron request'
            });
        }

        console.log('🚀 Vercel Cron: Creating Ink Chain prediction...');

        const templates = loadTemplates();
        if (templates.length === 0) {
            return res.status(500).json({
                success: false,
                error: 'No enabled templates found'
            });
        }

        // Load state
        const fs = require('fs');
        const path = require('path');
        const STATE_FILE = path.join(__dirname, '.auto-create-state.json');

        let state = { lastTemplateIndex: -1, createdCount: 0 };
        try {
            if (fs.existsSync(STATE_FILE)) {
                state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            }
        } catch (e) {
            console.warn('Could not load state:', e.message);
        }

        // Select next template
        const nextIndex = (state.lastTemplateIndex + 1) % templates.length;
        const template = templates[nextIndex];

        // Create prediction
        const success = await createPrediction(template);

        if (success) {
            // Update state
            state.lastTemplateIndex = nextIndex;
            state.createdCount++;
            state.lastCreated = new Date().toISOString();

            try {
                fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
            } catch (e) {
                console.warn('Could not save state:', e.message);
            }

            return res.status(200).json({
                success: true,
                message: 'Prediction created successfully',
                template: template.question,
                totalCreated: state.createdCount
            });
        } else {
            return res.status(500).json({
                success: false,
                error: 'Failed to create prediction'
            });
        }
    } catch (error) {
        console.error('Error in Vercel cron handler:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
};
