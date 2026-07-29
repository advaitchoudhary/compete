import { useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../src/api/client'
import { C, FONT, SPACE, RADIUS, TIER } from '../src/theme'
import { notify } from '../src/lib/dialog'

const FILTERS = ['pending', 'approved', 'rejected'] as const

export default function AdminScreen() {
  const router = useRouter()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('pending')
  const [actingId, setActingId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['admin-apps', filter],
    queryFn: () =>
      api.get(`/admin/referee-applications?status=${filter}`).then((r) => r.data).catch(() => null),
  })
  const apps: any[] = data?.applications ?? []

  const act = async (id: string, action: 'approve' | 'reject') => {
    setActingId(id)
    try {
      await api.post(`/admin/referee-applications/${id}/${action}`, {})
      qc.invalidateQueries({ queryKey: ['admin-apps'] })
      qc.invalidateQueries({ queryKey: ['referee-me'] })
    } catch (e: any) {
      notify('Failed', e?.response?.data?.error ?? 'Try again')
    } finally {
      setActingId(null)
    }
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Text style={s.back}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Referee Applications</Text>
        <View style={{ width: 20 }} />
      </View>

      {/* status filter */}
      <View style={s.filterRow}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f}
            activeOpacity={0.85}
            onPress={() => setFilter(f)}
            style={[s.filterChip, filter === f && s.filterChipOn]}
          >
            <Text style={[s.filterText, filter === f && { color: C.limeText }]}>{f.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: SPACE.xl, paddingTop: SPACE.sm, gap: SPACE.md }}>
        {isLoading ? (
          <ActivityIndicator color={C.lime} style={{ marginTop: 48 }} />
        ) : apps.length === 0 ? (
          <Text style={s.empty}>No {filter} applications.</Text>
        ) : (
          apps.map((a) => {
            const tierCfg = a.requested_tier ? TIER[a.requested_tier] : null
            return (
              <View key={a.id} style={s.card}>
                <View style={s.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.name}>{a.full_name}</Text>
                    <Text style={s.meta}>📍 {a.city}{a.experience_years ? `  ·  ${a.experience_years}y exp` : ''}</Text>
                  </View>
                  <View style={[s.typeBadge, a.request_type === 'upgrade' && { borderColor: C.amber + '66' }]}>
                    <Text style={[s.typeText, a.request_type === 'upgrade' && { color: C.amber }]}>
                      {a.request_type === 'upgrade' ? 'TIER UPGRADE' : 'NEW'}
                    </Text>
                  </View>
                </View>

                {!!(a.sports?.length) && (
                  <Text style={s.detail}>Sports: {a.sports.join(', ')}</Text>
                )}
                {!!a.certification && <Text style={s.detail}>Cert: {a.certification}</Text>}
                {tierCfg && (
                  <Text style={[s.detail, { color: tierCfg.color }]}>Requesting: {tierCfg.label}</Text>
                )}
                {!!a.bio && <Text style={s.bio}>“{a.bio}”</Text>}

                {filter === 'pending' ? (
                  <View style={s.actions}>
                    <TouchableOpacity
                      style={[s.btn, s.reject]}
                      activeOpacity={0.85}
                      disabled={actingId === a.id}
                      onPress={() => act(a.id, 'reject')}
                    >
                      <Text style={s.rejectText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.btn, s.approve]}
                      activeOpacity={0.85}
                      disabled={actingId === a.id}
                      onPress={() => act(a.id, 'approve')}
                    >
                      {actingId === a.id ? <ActivityIndicator color={C.limeText} /> : <Text style={s.approveText}>Approve</Text>}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Text style={[s.statusTag, { color: filter === 'approved' ? C.green : C.red }]}>
                    {filter === 'approved' ? '✓ Approved' : '✕ Rejected'}
                  </Text>
                )}
              </View>
            )
          })
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACE.xl, paddingVertical: SPACE.md, borderBottomWidth: 1, borderBottomColor: C.b1,
  },
  back: { color: C.t1, fontSize: 22, fontFamily: FONT.bold },
  headerTitle: { color: C.t1, fontSize: 17, fontFamily: FONT.bold },

  filterRow: { flexDirection: 'row', gap: SPACE.sm, paddingHorizontal: SPACE.xl, paddingVertical: SPACE.lg },
  filterChip: { paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm, borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.b1 },
  filterChipOn: { backgroundColor: C.lime, borderColor: C.lime },
  filterText: { color: C.t2, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 1 },

  empty: { color: C.t3, fontSize: 14, fontFamily: FONT.regular, textAlign: 'center', marginTop: 48 },

  card: { backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1, padding: SPACE.lg },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.md },
  name: { color: C.t1, fontSize: 17, fontFamily: FONT.bold },
  meta: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, marginTop: 2 },
  typeBadge: { borderWidth: 1, borderColor: C.b2, borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4 },
  typeText: { color: C.t2, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1 },
  detail: { color: C.t2, fontSize: 13, fontFamily: FONT.medium, marginTop: SPACE.sm },
  bio: { color: C.t2, fontSize: 13, fontFamily: FONT.regular, fontStyle: 'italic', marginTop: SPACE.sm },

  actions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.lg },
  btn: { flex: 1, borderRadius: RADIUS.md, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  reject: { backgroundColor: C.s3, borderWidth: 1, borderColor: C.b2 },
  rejectText: { color: C.t2, fontSize: 14, fontFamily: FONT.bold },
  approve: { backgroundColor: C.lime },
  approveText: { color: C.limeText, fontSize: 14, fontFamily: FONT.bold },

  statusTag: { fontSize: 13, fontFamily: FONT.bold, marginTop: SPACE.md },
})
