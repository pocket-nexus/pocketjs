import { NativeScriptConfig } from '@nativescript/core';

export default {
  id: 'dev.pocketjs.shell',
  appPath: 'src',
  appResourcesPath: 'App_Resources',
  ios: {
    runtimePackageName: '@nativescript/ios-quickjs',
  },
} as NativeScriptConfig;
