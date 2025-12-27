const { createClient } = require('@supabase/supabase-js');

// Check if Supabase credentials are configured
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('⚠️ Supabase credentials not configured. Admin features will be disabled.');
    console.warn('   Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env to enable database features.');
} else {
    try {
        // Initialize Supabase client with custom options
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            },
            global: {
                headers: {
                    'x-application-name': 'inkpredict-backend'
                },
                fetch: (...args) => {
                    // Custom fetch with longer timeout
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

                    return fetch(args[0], {
                        ...args[1],
                        signal: controller.signal
                    }).finally(() => clearTimeout(timeout));
                }
            }
        });

        console.log('✅ Supabase client initialized');

        // Test connection (non-blocking)
        supabase
            .from('predictions')
            .select('count')
            .limit(1)
            .then(({ error }) => {
                if (error) {
                    console.error('⚠️ Supabase connection test failed:', error.message);
                    console.error('   Admin features may not work correctly.');
                } else {
                    console.log('✅ Supabase connection verified');
                }
            })
            .catch(err => {
                console.error('⚠️ Supabase connection error:', {
                    message: err.message,
                    details: err.stack
                });
            });

    } catch (error) {
        console.error('❌ Failed to initialize Supabase client:', error.message);
        console.error('   Admin features will be disabled.');
    }
}

module.exports = supabase;
