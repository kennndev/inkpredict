#!/usr/bin/env node
/**
 * Auto-Create Ink Chain Predictions
 * 
 * This script automatically creates new Ink Chain predictions based on templates.
 * Can be run manually or scheduled via cron/task scheduler.
 * 
 * Usage:
 *   node auto-create-ink-predictions.js
 * 
 * Environment Variables:
 *   ADMIN_API_SECRET - Secret for admin API authentication
 *   API_URL - Backend API URL (default: http://localhost:3001)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3001';
const ADMIN_SECRET = process.env.ADMIN_API_SECRET;
const TEMPLATES_FILE = path.join(__dirname, 'prediction-templates.json');
const STATE_FILE = path.join(__dirname, '.auto-create-state.json');

/**
 * Load prediction templates
 */
function loadTemplates() {
    try {
        const data = fs.readFileSync(TEMPLATES_FILE, 'utf8');
        const templates = JSON.parse(data);
        return templates.filter(t => t.enabled !== false);
    } catch (error) {
        console.error('❌ Error loading templates:', error.message);
        return [];
    }
}

/**
 * Load state (tracks which template was used last)
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.warn('⚠️ Could not load state file:', error.message);
    }
    return { lastTemplateIndex: -1, createdCount: 0 };
}

/**
 * Save state
 */
function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('❌ Error saving state:', error.message);
    }
}

/**
 * Select next template (cycles through templates)
 */
function selectTemplate(templates, state) {
    if (templates.length === 0) {
        return null;
    }

    const nextIndex = (state.lastTemplateIndex + 1) % templates.length;
    return { template: templates[nextIndex], index: nextIndex };
}

/**
 * Create prediction via API
 */
async function createPrediction(template) {
    try {
        console.log(`\n🔮 Creating prediction: "${template.question}"`);
        console.log(`   Metric: ${template.targetMetric} ${template.metricType}`);
        console.log(`   Duration: ${template.durationHours} hours`);

        const payload = {
            category: template.category,
            question: template.question,
            emoji: template.emoji,
            inkContractAddress: template.inkContractAddress || '',
            targetMetric: template.targetMetric,
            metricType: template.metricType,
            durationHours: template.durationHours
        };

        const response = await axios.post(
            `${API_URL}/api/admin/predictions`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${ADMIN_SECRET}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.success) {
            console.log(`✅ Prediction created successfully!`);
            console.log(`   Market ID: ${response.data.marketId}`);
            console.log(`   TX Hash: ${response.data.transactionHash}`);
            return true;
        } else {
            console.error(`❌ Failed to create prediction:`, response.data.error);
            return false;
        }
    } catch (error) {
        console.error(`❌ Error creating prediction:`, error.response?.data?.error || error.message);
        return false;
    }
}

/**
 * Main function
 */
async function main() {
    console.log('🚀 Ink Chain Prediction Auto-Creator');
    console.log('=====================================\n');

    // Validate configuration
    if (!ADMIN_SECRET) {
        console.error('❌ ADMIN_API_SECRET not set in .env file');
        process.exit(1);
    }

    // Load templates
    const templates = loadTemplates();
    if (templates.length === 0) {
        console.error('❌ No enabled templates found in prediction-templates.json');
        process.exit(1);
    }

    console.log(`📋 Loaded ${templates.length} enabled template(s)`);

    // Load state
    const state = loadState();
    console.log(`📊 State: ${state.createdCount} predictions created so far`);

    // Select template
    const selection = selectTemplate(templates, state);
    if (!selection) {
        console.error('❌ Could not select template');
        process.exit(1);
    }

    // Create prediction
    const success = await createPrediction(selection.template);

    if (success) {
        // Update state
        state.lastTemplateIndex = selection.index;
        state.createdCount++;
        state.lastCreated = new Date().toISOString();
        saveState(state);

        console.log(`\n✨ Done! Total predictions created: ${state.createdCount}`);
        process.exit(0);
    } else {
        console.error('\n❌ Failed to create prediction');
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { loadTemplates, createPrediction };
