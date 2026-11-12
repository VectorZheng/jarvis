/** Local Android Studio / emulator testing uses app.json; store builds require an online API. */
module.exports = ({ config }) => {
  const isProduction = process.env.JARVIS_BUILD_ENV === 'production';
  const plugins = [...(config.plugins || [])].filter((entry) => {
    const name = Array.isArray(entry) ? entry[0] : entry;
    return name !== 'expo-build-properties';
  });

  // Local AS / emulator / LAN device debugging talks to http://LAN:9301.
  // Android 9+ blocks cleartext HTTP unless this is set at prebuild time.
  // Production builds keep cleartext off and require HTTPS (checked below).
  plugins.push([
    'expo-build-properties',
    {
      android: {
        usesCleartextTraffic: !isProduction,
      },
    },
  ]);

  if (!isProduction) {
    return { ...config, plugins };
  }

  const address = process.env.EXPO_PUBLIC_API_BASE;
  let backend;
  try { backend = new URL(address); } catch { /* checked below */ }
  const host = backend?.hostname.toLowerCase().replace(/^\[|\]$/g, '') || '';
  const isLocal = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') ||
    /^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(::|fc|fd|fe80:)/.test(host);
  if (!backend || backend.protocol !== 'https:' || isLocal || backend.username || backend.password || backend.search || backend.hash) {
    throw new Error('正式构建需要 EXPO_PUBLIC_API_BASE 指向可公开访问的 HTTPS 后端，不能使用 localhost 或局域网地址。');
  }

  // LAN permission and its HTTP exception are only needed for local testing.
  const infoPlist = { ...config.ios?.infoPlist };
  delete infoPlist.NSLocalNetworkUsageDescription;
  if (infoPlist.NSAppTransportSecurity) {
    const transport = { ...infoPlist.NSAppTransportSecurity };
    delete transport.NSAllowsLocalNetworking;
    if (Object.keys(transport).length) infoPlist.NSAppTransportSecurity = transport;
    else delete infoPlist.NSAppTransportSecurity;
  }
  return { ...config, plugins, ios: { ...config.ios, infoPlist } };
};
