import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { AppState, Platform } from 'react-native';
import { getCompanionAdapter } from '../companion/platform';
import { SettingsStore } from './store';
import type { CredentialSlot, CredentialVault } from './store';

const sessionKeys = new Map<CredentialSlot,string>();
const secureOptions = { keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const credentialVault:CredentialVault = Platform.OS==='web' ? {
  read:async slot=>sessionKeys.get(slot)??null,
  write:async(slot,value)=>{sessionKeys.set(slot,value);},
  remove:async slot=>{sessionKeys.delete(slot);},
} : {
  read:slot=>SecureStore.getItemAsync(`jarvis.provider.${slot}`,secureOptions),
  write:(slot,value)=>SecureStore.setItemAsync(`jarvis.provider.${slot}`,value,secureOptions),
  remove:slot=>SecureStore.deleteItemAsync(`jarvis.provider.${slot}`,secureOptions),
};
let singleton:SettingsStore|undefined;
export function getSettingsStore():SettingsStore {
  if(!singleton)singleton=new SettingsStore(AsyncStorage,credentialVault,getCompanionAdapter(),()=>AppState.currentState==='active',expoFetch);
  return singleton;
}
