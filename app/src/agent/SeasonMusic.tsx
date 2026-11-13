import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import React, { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Tap } from '../talk/press';
import { useSceneForeground } from './SeasonalAtmosphere';
import { MUSIC_LABELS, SEASON_MUSIC, useMusicPreference, type MusicProps } from './seasonMusicConfig';

export function SeasonMusic({ season, active, color }: MusicProps) {
  const player = useAudioPlayer(SEASON_MUSIC[season]);
  const status = useAudioPlayerStatus(player);
  const foreground = useSceneForeground();
  const { enabled, ready, change } = useMusicPreference();
  const shouldPlay = active && foreground && enabled && ready && status.isLoaded;
  useEffect(() => {
    // Expo exposes volume and loop as mutable setters on its native player handle.
    // eslint-disable-next-line react-hooks/immutability
    player.loop = true;
    player.volume = 0;
    if (!shouldPlay) { player.pause(); return; }
    player.play();
    let step = 0;
    const fade = setInterval(() => { player.volume = Math.min(0.14, ++step * 0.014); if (step >= 10) clearInterval(fade); }, 100);
    return () => { clearInterval(fade); player.pause(); };
  }, [player, shouldPlay]);
  return <Tap testID="season-music" accessibilityRole="button" accessibilityLabel={`${enabled ? '关闭' : '播放'}${MUSIC_LABELS[season]}`} disabled={!ready} onPress={() => change(!enabled)} style={s.button}>
    <Ionicons name={status.playing ? 'musical-notes-outline' : 'volume-mute-outline'} size={16} color={color}/><Text style={[s.label, { color }]}>音乐</Text>
  </Tap>;
}
const s = StyleSheet.create({ button: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 5 }, label: { fontSize: 11 } });
