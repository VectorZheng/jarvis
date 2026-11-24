import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { NATIVE_MODULE_NAME } from './contracts';
import { createCompanionAdapter } from './adapter';
import type { NativeCompanionModule } from './adapter';
import type { CompanionAdapter } from './core';

let singleton: CompanionAdapter | undefined;
/** 所有页面共享同一 adapter；Android 从不读写 local_fallback。 */
export function getCompanionAdapter(): CompanionAdapter {
  if (!singleton) {
    const platform = Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web';
    const native = platform === 'android' ? requireOptionalNativeModule<NativeCompanionModule>(NATIVE_MODULE_NAME) : null;
    singleton = createCompanionAdapter(platform,native,AsyncStorage);
  }
  return singleton;
}
