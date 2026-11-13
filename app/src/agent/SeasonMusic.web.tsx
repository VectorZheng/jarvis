import { Ionicons } from '@expo/vector-icons';
import { Asset } from 'expo-asset';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Tap } from '../talk/press';
import { useSceneForeground } from './SeasonalAtmosphere';
import { MUSIC_LABELS, SEASON_MUSIC, useMusicPreference, type MusicProps } from './seasonMusicConfig';

/** Use the browser play promise so autoplay denial is handled, not an unhandled rejection. */
export function SeasonMusic({ season, active, color }: MusicProps) {
  const { enabled, ready, change } = useMusicPreference();
  const foreground = useSceneForeground();
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const start = useRef<(() => void) | null>(null);
  useEffect(() => {
    const audio = new Audio(Asset.fromModule(SEASON_MUSIC[season]).uri);
    audio.loop = true;
    audio.volume = 0;
    let disposed = false;
    let fade: ReturnType<typeof setInterval> | undefined;
    audio.onplay = () => { if (!disposed) { setPlaying(true); setBlocked(false); } };
    audio.onpause = () => { if (!disposed) setPlaying(false); };
    const play = () => {
      if (!active || !foreground || !enabled || !ready || disposed) return;
      void audio.play().then(() => {
        if (disposed) { audio.pause(); return; }
        if (fade) clearInterval(fade);
        let step = 0;
        fade = setInterval(() => { audio.volume = Math.min(0.14, ++step * 0.014); if (step >= 10) clearInterval(fade); }, 100);
      }).catch(() => { if (!disposed) { setPlaying(false); setBlocked(true); } });
    };
    start.current = play;
    const unlock = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="season-music"], [data-testid="agent-orb"]')) return;
      if (audio.paused) play();
    };
    if (active && foreground && enabled && ready) {
      play();
      document.addEventListener('pointerdown', unlock);
      document.addEventListener('keydown', unlock);
    }
    return () => {
      disposed = true; start.current = null;
      document.removeEventListener('pointerdown', unlock); document.removeEventListener('keydown', unlock);
      if (fade) clearInterval(fade);
      audio.pause(); audio.onplay = null; audio.onpause = null; audio.removeAttribute('src'); audio.load();
    };
  }, [active, enabled, foreground, ready, season]);
  const audible = playing && active && foreground && enabled;
  return <Tap testID="season-music" accessibilityRole="button" accessibilityLabel={`${audible ? '关闭' : '播放'}${MUSIC_LABELS[season]}`} disabled={!ready} onPress={() => { if (enabled && blocked) start.current?.(); else change(!enabled); }} style={s.button}>
    <Ionicons name={audible ? 'musical-notes-outline' : 'volume-mute-outline'} size={16} color={color}/><Text style={[s.label, { color }]}>{enabled && blocked ? '点播' : '音乐'}</Text>
  </Tap>;
}
const s = StyleSheet.create({ button: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 5 }, label: { fontSize: 11 } });
