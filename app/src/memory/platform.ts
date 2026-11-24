import AsyncStorage from '@react-native-async-storage/async-storage';
import { MemoryStore } from './store';
let singleton:MemoryStore|undefined;
export function getMemoryStore():MemoryStore {if(!singleton)singleton=new MemoryStore(AsyncStorage);return singleton;}
