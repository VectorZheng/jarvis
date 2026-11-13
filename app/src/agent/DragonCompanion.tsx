import React, { memo, useEffect } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSceneForeground } from './SeasonalAtmosphere';

type Props = { size: number; active: boolean; reduceMotion: boolean; pulse: SharedValue<number> };

/** Small white dragon companion. Motion stays on the UI thread and pauses offscreen. */
export const DragonCompanion = memo(function DragonCompanion({ size, active, reduceMotion, pulse }: Props) {
  const foreground = useSceneForeground();
  const phase = useSharedValue(0);
  const moving = active && foreground && !reduceMotion;
  useEffect(() => {
    cancelAnimation(phase);
    if (moving) {
      const start = phase.get();
      phase.set(withRepeat(withTiming(start + Math.PI * 2, { duration: 5600, easing: Easing.linear }), -1, false));
    }
    return () => cancelAnimation(phase);
  }, [moving, phase]);
  const motion = useAnimatedStyle(() => {
    const t = reduceMotion ? 0 : phase.get();
    const response = moving ? pulse.get() : 0;
    return { transform: [{ translateY: Math.sin(t) * 3 - response * 3 }, { rotate: `${Math.sin(t) * 1.2}deg` }, { scale: 1 + Math.sin(t * 2) * 0.012 + response * 0.035 }] };
  });
  const shadow = useAnimatedStyle(() => ({ opacity: 0.12 + Math.sin(reduceMotion ? 0 : phase.get()) * 0.025, transform: [{ scaleX: 1 - Math.sin(reduceMotion ? 0 : phase.get()) * 0.06 }] }));
  return <View testID="dragon-companion" pointerEvents="none" accessible={false} style={{ width: size, height: size }}>
    <Animated.View style={[s.shadow, { width: size * 0.48, left: size * 0.26 }, shadow]} />
    <Animated.View testID="dragon-companion-body" style={[StyleSheet.absoluteFill, motion]}>
      <Image source={require('../../assets/characters/dragon-girl-white.png')} style={s.image} resizeMode="contain" fadeDuration={0} />
    </Animated.View>
  </View>;
});
const s = StyleSheet.create({ image: { width: '100%', height: '100%' }, shadow: { position: 'absolute', bottom: -3, height: 5, borderRadius: 30, backgroundColor: '#69686E' } });
