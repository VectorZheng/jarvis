import React from 'react';
import { useFonts } from 'expo-font';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

export const ink = { text:'#193D37',muted:'#64766E',paper:'#F4F3E9',card:'#FFFEF8',line:'#D5DCD0',accent:'#245D4B',soft:'#E5EBDD',danger:'#9D4437' };
export function SectionTitle({index,title,subtitle}:{index:string;title:string;subtitle?:string}) {
  const [loaded]=useFonts({JarvisGreeting:require('../../assets/fonts/JarvisGreeting-Regular.ttf')});
  return <View style={ui.heading}><Text style={ui.eyebrow}>{index} / JARVIS · 随身手记</Text><Text accessibilityRole="header" style={[ui.title,loaded&&{fontFamily:'JarvisGreeting'}]}>{title}</Text>{subtitle?<Text style={ui.muted}>{subtitle}</Text>:null}</View>;
}
export function Action({label,onPress,disabled=false,danger=false,primary=false,testID}:{label:string;onPress:()=>void;disabled?:boolean;danger?:boolean;primary?:boolean;testID?:string}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={({pressed})=>[ui.action,primary&&ui.primary,danger&&ui.danger,disabled&&{opacity:0.4},pressed&&{opacity:0.72}]}><Text style={[ui.actionText,primary&&{color:ink.card},danger&&{color:ink.danger}]}>{label}</Text></Pressable>;
}
export function Field({label,...props}:TextInputProps&{label:string}) {
  return <View style={ui.field}><Text style={ui.label}>{label}</Text><TextInput accessibilityLabel={label} placeholderTextColor={ink.muted} {...props} style={[ui.input,props.multiline&&{minHeight:90,textAlignVertical:'top'},props.style]}/></View>;
}
export function Toggle({label,detail,value,onChange,disabled=false}:{label:string;detail?:string;value:boolean;onChange:(value:boolean)=>void;disabled?:boolean}) {
  return <View style={ui.toggle}><View style={{flex:1,gap:4}}><Text style={ui.label}>{label}</Text>{detail?<Text style={ui.muted}>{detail}</Text>:null}</View><Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} trackColor={{false:ink.line,true:ink.accent}} thumbColor={ink.card}/></View>;
}
export function Feedback({text,error=false}:{text:string;error?:boolean}) {return text?<Text accessibilityLiveRegion="polite" style={[ui.feedback,error&&{color:ink.danger}]}>{text}</Text>:null;}
export const ui=StyleSheet.create({
  page:{padding:22,paddingBottom:44,gap:18,backgroundColor:ink.paper},heading:{gap:10,paddingTop:12,paddingBottom:12,borderBottomWidth:1,borderBottomColor:ink.line},eyebrow:{fontSize:10,letterSpacing:2,color:ink.muted,fontWeight:'600'},title:{fontSize:31,color:ink.text,lineHeight:42},card:{padding:18,gap:13,backgroundColor:ink.card,borderColor:ink.line,borderWidth:1,borderRadius:16},cardTitle:{fontSize:18,fontWeight:'600',color:ink.text},muted:{fontSize:12,lineHeight:20,color:ink.muted},body:{fontSize:15,lineHeight:24,color:ink.text},label:{fontSize:13,lineHeight:20,color:ink.text,fontWeight:'600'},row:{flexDirection:'row',gap:9,alignItems:'center',flexWrap:'wrap'},action:{minHeight:44,justifyContent:'center',alignItems:'center',paddingHorizontal:15,paddingVertical:10,borderRadius:24,borderWidth:1,borderColor:ink.line},primary:{backgroundColor:ink.accent,borderColor:ink.accent},danger:{borderColor:'#E3C1B7'},actionText:{fontSize:13,fontWeight:'600',color:ink.text},field:{gap:6},input:{borderWidth:1,borderColor:ink.line,borderRadius:10,paddingHorizontal:12,paddingVertical:12,minHeight:46,fontSize:14,color:ink.text,backgroundColor:ink.card},toggle:{flexDirection:'row',gap:12,alignItems:'center',paddingVertical:8},feedback:{fontSize:13,lineHeight:22,color:ink.accent},rule:{height:1,backgroundColor:ink.line},badge:{alignSelf:'flex-start',backgroundColor:ink.soft,color:ink.accent,fontSize:11,paddingHorizontal:10,paddingVertical:5,borderRadius:20},large:{fontSize:38,fontWeight:'300',fontVariant:['tabular-nums'],color:ink.text},
});
