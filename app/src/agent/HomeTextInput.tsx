import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Tap } from '../talk/press';
import { LinearGradient } from 'expo-linear-gradient';
import { AFTERNOON_HOME_THEME, inkOnAccent, type HomeTheme } from '../theme/homeTheme';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

type Props = {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder: string;
  inputTestID: string;
  sendTestID: string;
  theme?: HomeTheme;
};

/** Glass stays underneath an explicit foreground so editable text remains sharp. */
export function HomeTextInput({ value, busy, onChange, onSend, onStop, onFocus, onBlur, placeholder, inputTestID, sendTestID, theme = AFTERNOON_HOME_THEME }: Props) {
  const dark = theme.mode !== 'light';
  const [height, setHeight] = useState(44);
  const focusProgress = useSharedValue(0);
  const stopping = busy && Boolean(onStop);
  const disabled = !stopping && (busy || !value.trim());
  const onKeyPress: TextInputProps['onKeyPress'] = event => {
    if (Platform.OS !== 'web') return;
    const key = event.nativeEvent as typeof event.nativeEvent & { shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
    if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.keyCode === 229) return;
    event.preventDefault();
    if (!busy && value.trim()) onSend();
  };
  const focusStyle = useAnimatedStyle(() => ({ opacity: focusProgress.get() }));
  const setFocus = (next: number) => {
    cancelAnimation(focusProgress);
    focusProgress.set(withTiming(next, { duration: 220, easing: Easing.out(Easing.cubic) }));
  };
  return <View testID={inputTestID + '-surface'} style={[s.surface, { backgroundColor: dark ? 'rgba(28,30,34,0.84)' : 'rgba(255,255,255,0.76)' }]}>
    <View pointerEvents="none" style={s.glass}>
      <LinearGradient colors={dark ? ['rgba(255,255,255,0.06)', 'transparent'] : ['rgba(255,255,255,0.28)', 'rgba(225,235,239,0.08)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.glass} />
    </View>
    <Animated.View pointerEvents="none" style={[s.focusOverlay, focusStyle]} />
    <View style={s.foreground}>
    <TextInput
      testID={inputTestID}
      accessibilityLabel="和 Jarvis 说话"
      value={value}
      onChangeText={onChange}
      onFocus={() => { setFocus(1); onFocus?.(); }}
      onBlur={() => { setFocus(0); onBlur?.(); }}
      placeholder={placeholder}
      placeholderTextColor={dark ? '#BBC0C8' : '#606770'}
      editable={!busy}
      multiline
      numberOfLines={1}
      submitBehavior="newline"
      onKeyPress={onKeyPress}
      onContentSizeChange={Platform.OS === 'web' ? undefined : event => setHeight(Math.min(140, Math.max(44, Math.ceil(event.nativeEvent.contentSize.height))))}
      maxLength={2000}
      textAlignVertical="top"
      underlineColorAndroid="transparent"
      style={[s.input, { color: theme.text }, Platform.OS === 'web' ? s.webInput : { height: value ? height : 44 }]}
    />
    <Tap testID={sendTestID} accessibilityRole="button" accessibilityLabel={stopping ? '停止回复' : '发送'} feedback="light" disabled={disabled} onPress={stopping ? onStop : onSend} style={[s.send, { backgroundColor: theme.accent }, disabled && s.disabled]}>
      <Ionicons name={stopping ? 'stop' : 'arrow-up'} size={stopping ? 15 : 21} color={disabled ? theme.muted : inkOnAccent(theme)} />
    </Tap>
    </View>
  </View>;
}
const s = StyleSheet.create({
  surface: { minHeight: 58, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.14)', boxShadow: '0 3px 14px rgba(40,54,68,0.06)' },
  glass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 0, borderRadius: 26, overflow: 'hidden' },
  foreground: { position: 'relative', zIndex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 10, padding: 6, paddingLeft: 18 },
  focusOverlay: { ...StyleSheet.absoluteFill, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.10)', boxShadow: '0 3px 16px rgba(40,54,68,0.09)' },
  input: { position: 'relative', flex: 1, minWidth: 0, minHeight: 44, maxHeight: 140, paddingHorizontal: 0, paddingVertical: 10, fontSize: 16, lineHeight: 24, color: '#20242B', backgroundColor: 'transparent' },
  webInput: { outlineStyle: 'none', fieldSizing: 'content', overflowY: 'auto', resize: 'none' } as never,
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#384554', alignItems: 'center', justifyContent: 'center' },
  disabled: { backgroundColor: 'rgba(82,98,113,0.10)' },
});
