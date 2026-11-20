import type { ReactNode } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

export const color = {
  canvas: '#F4F3EB', paper: '#FFFEFA', ink: '#132F29', dark: '#142E28', accent: '#D9F58C',
  primary: '#286448', faint: '#E5E9D9', muted: '#50645A', outline: '#D8DFD2',
  danger: '#9F3029', dangerBg: '#FAE6E2', white: '#FFFFFF',
};

export const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: color.canvas},
  page: {flex: 1, backgroundColor: color.canvas},
  content: {width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingBottom: 28, gap: 16},
  title: {color: color.ink, fontSize: 28, lineHeight: 36, fontWeight: '800', letterSpacing: -0.7},
  heading: {color: color.ink, fontSize: 19, lineHeight: 27, fontWeight: '800', letterSpacing: -0.35},
  body: {color: color.ink, fontSize: 16, lineHeight: 25},
  small: {color: color.muted, fontSize: 13, lineHeight: 20},
  label: {color: color.primary, fontSize: 12, lineHeight: 18, fontWeight: '800', letterSpacing: 1.5},
  row: {flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap'},
  between: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10},
  card: {backgroundColor: color.paper, borderWidth: 1, borderColor: color.outline, borderRadius: 20, padding: 16, gap: 9},
  field: {backgroundColor: color.paper, borderColor: color.outline, borderWidth: 1, borderRadius: 13, padding: 13, minHeight: 49, color: color.ink, fontSize: 16},
  notice: {backgroundColor: color.faint, borderRadius: 14, padding: 12, gap: 5},
});

export function Page({children}: {children: ReactNode}) {
  return <SafeAreaProvider><SafeAreaView style={styles.safe}>
    <StatusBar barStyle="dark-content"/><View style={styles.page}>{children}</View>
  </SafeAreaView></SafeAreaProvider>;
}

export function Button({label, onPress, variant = 'outline', disabled = false}: {
  label: string; onPress: () => void; variant?: 'primary'|'outline'|'danger'|'accent'; disabled?: boolean;
}) {
  const bg = variant === 'primary' ? color.dark : variant === 'accent' ? color.accent :
    variant === 'danger' ? color.dangerBg : color.paper;
  return <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
    style={({pressed}) => ({paddingHorizontal: 14, paddingVertical: 10, minHeight: 48, justifyContent: 'center',
      backgroundColor: bg, borderRadius: 13, borderColor: variant === 'outline' ? color.outline : bg,
      borderWidth: 1, opacity: pressed || disabled ? 0.55 : 1})}>
    <Text style={{fontSize: 14, lineHeight: 21, fontWeight: '800', color: variant === 'primary' ? color.white :
      variant === 'danger' ? color.danger : color.ink}}>{label}</Text>
  </Pressable>;
}

export function Field({label, ...props}: TextInputProps & {label: string}) {
  return <View style={{gap: 6}}><Text style={styles.small}>{label}</Text>
    <TextInput {...props} accessibilityLabel={label} placeholderTextColor={color.muted} style={[styles.field, props.style]} />
  </View>;
}

export function Header({title, sub, onBack}: {title?: string; sub?: string; onBack: () => void}) {
  return <View style={[styles.content, {paddingTop: 10, paddingBottom: 12, gap: 6}]}>
    <View style={styles.row}><Button label="‹ 돌아가기" onPress={onBack} /></View>
    {sub && <Text style={styles.label}>{sub}</Text>}
    {title && <Text accessibilityRole="header" style={styles.title}>{title}</Text>}
  </View>;
}

export function Notice({text, danger = false}: {text: string; danger?: boolean}) {
  return <View style={[styles.notice, danger && {backgroundColor: color.dangerBg}]} accessible accessibilityLiveRegion="polite">
    <Text style={[styles.small, danger && {color: color.danger}]}>{text}</Text>
  </View>;
}
