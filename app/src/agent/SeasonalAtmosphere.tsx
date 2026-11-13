import React, { memo, useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import type { Season } from './SeasonBackground';

export function useSceneForeground() {
  const [foreground, setForeground] = useState(() => AppState.currentState !== 'background' && (Platform.OS !== 'web' || !document.hidden));
  useEffect(() => {
    const refresh = () => setForeground(AppState.currentState !== 'background' && AppState.currentState !== 'inactive' && (Platform.OS !== 'web' || !document.hidden));
    const subscription = AppState.addEventListener('change', refresh);
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', refresh);
    return () => { subscription.remove(); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return foreground;
}

/** One UI-thread clock for all decorations; no per-frame React state or timers. */
export const SeasonalAtmosphere = memo(function SeasonalAtmosphere({ season, active, reduceMotion, dark }: { season: Season; active: boolean; reduceMotion: boolean; dark: boolean }) {
  const [size, setSize] = useState({ width: 430, height: 800 });
  const foreground = useSceneForeground();
  const phase = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(phase);
    if (active && foreground && !reduceMotion) {
      const start = phase.get();
      phase.set(withRepeat(withTiming(start + 1, { duration: 24000, easing: Easing.linear }), -1, false));
    }
    return () => cancelAnimation(phase);
  }, [active, foreground, phase, reduceMotion]);
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={`season-motion-${season}`} style={[s.layer, { opacity: dark ? 0.52 : 0.78 }]} onLayout={event => {
    const { width, height } = event.nativeEvent.layout;
    setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
  }}>
    {season === 'spring' ? [0, 1, 2, 3].map(index => <Willow key={index} index={index} phase={phase} width={size.width} />) : null}
    {season === 'summer' ? <>
      {[0, 1, 2].map(index => <Dragonfly key={index} index={index} phase={phase} width={size.width} height={size.height} />)}
      <View style={s.cicada}><Svg width={52} height={90} viewBox="0 0 52 90"><Path d="M25 90 Q22 40 33 0" stroke="#748465" strokeWidth={2} fill="none"/><Ellipse cx={27} cy={48} rx={5} ry={14} fill="#606E51"/><Ellipse cx={21} cy={51} rx={7} ry={18} rotation={-17} origin="21,51" fill="#DCE6BC" fillOpacity={0.62} stroke="#718660" strokeWidth={0.7}/><Ellipse cx={33} cy={51} rx={7} ry={18} rotation={17} origin="33,51" fill="#DCE6BC" fillOpacity={0.62} stroke="#718660" strokeWidth={0.7}/><Circle cx={27} cy={34} r={5} fill="#657654"/></Svg></View>
    </> : null}
    {season === 'autumn' || season === 'winter' ? Array.from({ length: season === 'winter' ? 24 : 10 }, (_, index) => <FallingParticle key={`${season}-${index}`} season={season} index={index} phase={phase} width={size.width} height={size.height} />) : null}
  </View>;
});

function Willow({ index, phase, width }: { index: number; phase: SharedValue<number>; width: number }) {
  const right = index > 1;
  const motion = useAnimatedStyle(() => ({ transform: [{ rotate: `${(right ? -7 : 7) + Math.sin(phase.get() * Math.PI * 8 + index) * 5}deg` }] }));
  return <Animated.View testID={`willow-${index}`} style={[s.branch, { left: right ? width - 20 + (index - 2) * 13 : -33 + index * 13, top: -46 - (index % 2) * 35 }, motion]}>
    <Svg width={48} height={230} viewBox="0 0 80 290">
      <Path d="M35 0 C9 82 68 156 37 278" stroke="#779567" strokeWidth={1.1} fill="none" />
      {Array.from({ length: 12 }, (_, leaf) => {
        const y = 30 + leaf * 20;
        const x = 34 + Math.sin(leaf * 0.5) * 8;
        return <G key={leaf} transform={`translate(${x} ${y})`}><Path d="M0 0 Q-27 3 -25 34 Q-8 28 0 0" fill={leaf % 2 ? '#6C9B57' : '#8CAA67'} /><Path d="M0 3 Q24 8 21 38 Q6 26 0 3" fill="#7FA85D" /></G>;
      })}
    </Svg>
  </Animated.View>;
}

function Dragonfly({ index, phase, width, height }: { index: number; phase: SharedValue<number>; width: number; height: number }) {
  const flight = useAnimatedStyle(() => {
    const angle = phase.get() * Math.PI * 2 * (index + 1) + index * 2;
    return { transform: [{ translateX: (index % 2 ? width - 62 : 12) + Math.sin(angle) * 28 }, { translateY: height * (0.23 + index * 0.23) + Math.cos(angle * 2) * 27 }, { rotate: `${Math.sin(angle) * 18 - 20}deg` }] };
  });
  const wings = useAnimatedStyle(() => ({ transform: [{ scaleY: 0.65 + Math.sin(phase.get() * Math.PI * 240) * 0.28 }] }));
  return <Animated.View style={[s.dragonfly, flight]} testID={`dragonfly-${index}`}>
    <Animated.View style={[StyleSheet.absoluteFill, wings]}><Svg width={55} height={46} viewBox="0 0 55 46"><G fill="#E2EEE4" fillOpacity={0.72} stroke="#7C9E93" strokeWidth={0.6}><Ellipse cx={15} cy={17} rx={14} ry={5} rotation={-20} origin="15,17"/><Ellipse cx={40} cy={17} rx={14} ry={5} rotation={20} origin="40,17"/><Ellipse cx={16} cy={25} rx={12} ry={4} rotation={-32} origin="16,25"/><Ellipse cx={39} cy={25} rx={12} ry={4} rotation={32} origin="39,25"/></G></Svg></Animated.View>
    <Svg width={55} height={46} viewBox="0 0 55 46"><Path d="M27.5 12 L27.5 41" stroke="#648E8D" strokeWidth={2.4} strokeLinecap="round"/><Circle cx={27.5} cy={10} r={3} fill="#486E6B"/></Svg>
  </Animated.View>;
}

function FallingParticle({ season, index, phase, width, height }: { season: 'autumn' | 'winter'; index: number; phase: SharedValue<number>; width: number; height: number }) {
  const snow = season === 'winter';
  const size = snow ? 3 + index % 4 : 16 + index % 3 * 5;
  const motion = useAnimatedStyle(() => {
    const t = (phase.get() * (1 + index % 3) + index * 0.137) % 1;
    const baseX = snow ? ((index * 0.618) % 1) * width : index % 2 ? width - 42 - index % 3 * 11 : 8 + index % 3 * 15;
    return { opacity: Math.min(1, t * 12, (1 - t) * 12) * (snow ? 0.75 : 0.65), transform: [{ translateX: baseX + Math.sin(t * Math.PI * 4 + index) * (snow ? 15 : 24) }, { translateY: t * (height + 60) - 30 }, { rotate: `${t * (snow ? 90 : 300) + index * 37}deg` }] };
  });
  return <Animated.View testID={`falling-${season}-${index}`} style={[s.particle, { width: size, height: size }, motion]}>
    {snow ? <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#FFFFFF', boxShadow: '0 0 3px #DCE6EA' }} /> : <Svg width={size} height={size} viewBox="0 0 28 28"><Path d="M3 23 Q-1 5 23 2 Q28 23 3 23" fill={index % 2 ? '#C99B45' : '#D5B766'} /><Path d="M2 27 L21 5 M9 18 L8 10 M13 15 L21 15" fill="none" stroke="#A07E45" strokeWidth={0.8}/></Svg>}
  </Animated.View>;
}

const s = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  branch: { position: 'absolute', width: 48, height: 230, opacity: 0.72, transformOrigin: 'top center' },
  particle: { position: 'absolute', top: 0, left: 0 },
  dragonfly: { position: 'absolute', top: 0, left: 0, width: 55, height: 46 },
  cicada: { position: 'absolute', bottom: 170, left: -6, opacity: 0.65 },
});
