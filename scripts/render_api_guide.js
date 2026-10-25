// Render API approach for clearing cache and rebuilding
// Render API: https://api.render.com/
// API key can be found in Render dashboard under Account > API Keys

// Available endpoints:
// GET /v1/services/{serviceId}/deploys - list deploys
// POST /v1/services/{serviceId}/deploys - create deploy
// DELETE /v1/services/{serviceId}/deploys/{deployId}/cache - clear cache

// Service ID can be found from the Render dashboard URL:
// https://dashboard.render.com/web-services/<SERVICE_ID>

console.log('=== Render API Documentation for wingo-racer ===\n');
console.log('Base URL: https://api.render.com/v1');
console.log('\nEndpoints:');
console.log('  POST   /services/{serviceId}/deploys  → Trigger new deploy');
console.log('  GET    /services/{serviceId}/deploys  → List deploys');
console.log('\nTo use: curl -X POST https://api.render.com/v1/services/<SERVICE_ID>/deploys -H "Authorization: Bearer <API_KEY>"');
console.log('\nThe SERVICE_ID for wingo-racer can be found at:');
console.log('  https://dashboard.render.com/web-services/<SERVICE_ID>');
console.log('\nYou can also clear cache via:');
console.log('  DELETE /services/{serviceId}/deploys/{deployId}/cache');
