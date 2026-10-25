const https = require('https');

// Try to extract download links from the page source
const url = 'https://fb999login.ng/download.html';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    // Search for APK/IPA download links
    const apkMatch = data.match(/(https?:\/\/[^"'\s<>]+\.apk)/gi);
    const ipaMatch = data.match(/(https?:\/\/[^"'\s<>]+itms-apps[^"'\s<>]*)|([^"'\s<>]*\.ipa)/gi);
    const appstoreMatch = data.match(/apps\.apple\.com[^"'\s<>]*/gi);
    const playstoreMatch = data.match(/play\.google\.com[^"'\s<>]*/gi);
    const jsMatch = data.match(/downloadApp|download_app|app_download|apk_url|ipa_url|apkUrl|ipaUrl/gi);
    
    console.log('APK links:', apkMatch);
    console.log('IPA/AppStore links:', ipaMatch);
    console.log('AppStore links:', appstoreMatch);
    console.log('PlayStore links:', playstoreMatch);
    console.log('JS references:', jsMatch);
    
    // Look for inline scripts
    const scriptTags = data.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptTags) {
      console.log('\n=== Inline scripts ===');
      scriptTags.forEach((s, i) => {
        const content = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
        if (content.includes('download') || content.includes('apk') || content.includes('ipa') || content.includes('App')) {
          console.log(`Script ${i}:`, content.substring(0, 500));
        }
      });
    }
    
    // Look for hrefs with download
    const downloadHrefs = data.match(/href\s*=\s*["'][^"']*download[^"']*["']/gi);
    console.log('Download hrefs:', downloadHrefs);
  });
}).on('error', e => {
  console.error('Error:', e.message);
});
