import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.tillith.privatechat',
  appName: 'Tillith',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: { CapacitorHttp: { enabled: true } },
};
export default config;
