import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Season } from './SeasonBackground';

export const SEASON_MUSIC = {
  spring: require('../../assets/audio/spring.wav'),
  summer: require('../../assets/audio/summer.wav'),
  autumn: require('../../assets/audio/autumn.wav'),
  winter: require('../../assets/audio/winter.wav'),
};
export const MUSIC_LABELS: Record<Season, string> = { spring: '春日轻曲', summer: '夏日轻曲', autumn: '秋日轻曲', winter: '冬日轻曲' };
export type MusicProps = { season: Season; active: boolean; color: string };
const KEY = 'jarvis_season_music_enabled';

export function useMusicPreference() {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(KEY).then(value => { if (mounted) setEnabled(value !== 'false'); }).catch(() => {}).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);
  const change = useCallback((next: boolean) => {
    setEnabled(next);
    writes.current = writes.current.then(() => AsyncStorage.setItem(KEY, String(next))).catch(() => {});
  }, []);
  return { enabled, ready, change };
}
