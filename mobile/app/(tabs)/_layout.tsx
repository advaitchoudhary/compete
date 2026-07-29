import { Tabs } from 'expo-router'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { C, FONT } from '../../src/theme'

type TabIconProps = {
  emoji: string
  label: string
  focused: boolean
  activeColor: string
}

function TabIcon({ emoji, label, focused, activeColor }: TabIconProps) {
  return (
    <View style={ti.wrap}>
      {focused && <View style={[ti.pip, { backgroundColor: activeColor }]} />}
      <Text style={[ti.emoji, { opacity: focused ? 1 : 0.28 }]}>{emoji}</Text>
      <Text style={[ti.label, { color: focused ? activeColor : C.t3 }]}>{label}</Text>
    </View>
  )
}

const ti = StyleSheet.create({
  wrap:  { alignItems: 'center', gap: 2, paddingTop: 4 },
  emoji: { fontSize: 20 },
  label: { fontSize: 10, fontFamily: FONT.bold, letterSpacing: 0.8 },
  pip: {
    position: 'absolute',
    top: -12,
    width: 24,
    height: 2.5,
    borderRadius: 2,
  },
})

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: C.s1,
          borderTopWidth: 1,
          borderTopColor: C.b1,
          height: Platform.OS === 'ios' ? 86 : 64,
          paddingBottom: Platform.OS === 'ios' ? 28 : 10,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarShowLabel: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="⚡" label="Feed" focused={focused} activeColor={C.lime} />
          ),
        }}
      />
      <Tabs.Screen
        name="matches"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="🏆" label="Matches" focused={focused} activeColor={C.lime} />
          ),
        }}
      />
      <Tabs.Screen
        name="leaderboard"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="📊" label="Ranks" focused={focused} activeColor={C.lime} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          tabBarIcon: ({ focused }) => (
            <TabIcon emoji="👤" label="Profile" focused={focused} activeColor={C.lime} />
          ),
        }}
      />
    </Tabs>
  )
}
