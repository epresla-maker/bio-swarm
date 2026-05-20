import { StatusBar } from "expo-status-bar";
import { SafeAreaView, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useMemo, useState } from "react";

export default function App() {
  const [charging, setCharging] = useState(true);
  const [wifi, setWifi] = useState(true);
  const [idle, setIdle] = useState(false);
  const [optIn, setOptIn] = useState(true);

  const canRun = useMemo(() => charging && wifi && idle && optIn, [charging, wifi, idle, optIn]);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Bio Swarm Node</Text>
        <Text style={styles.subtitle}>Distributed biomedical compute on iPhone</Text>

        <Card label="Charging" value={charging} setValue={setCharging} />
        <Card label="Wi-Fi Connected" value={wifi} setValue={setWifi} />
        <Card label="Idle Mode" value={idle} setValue={setIdle} />
        <Card label="User Opt-in" value={optIn} setValue={setOptIn} />

        <View style={[styles.statusCard, canRun ? styles.ok : styles.waiting]}>
          <Text style={styles.statusTitle}>{canRun ? "Node Active" : "Node Paused"}</Text>
          <Text style={styles.statusText}>
            {canRun
              ? "This device can safely accept distributed compute tasks."
              : "Waiting for all policy constraints to be satisfied."}
          </Text>
        </View>

        <View style={styles.metrics}>
          <Metric title="Tasks Processed" value="124" />
          <Metric title="Contribution" value="3.6 GPUh eq" />
          <Metric title="Confidence" value="97.4%" />
        </View>
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function Card({
  label,
  value,
  setValue
}: {
  label: string;
  value: boolean;
  setValue: (next: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch value={value} onValueChange={setValue} />
    </View>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricTitle}>{title}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f6f8fb"
  },
  container: {
    padding: 20,
    gap: 14
  },
  title: {
    fontSize: 32,
    fontWeight: "800",
    color: "#0a1f44"
  },
  subtitle: {
    fontSize: 15,
    color: "#334155",
    marginBottom: 8
  },
  row: {
    backgroundColor: "white",
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  rowLabel: {
    fontSize: 16,
    color: "#0f172a",
    fontWeight: "600"
  },
  statusCard: {
    borderRadius: 16,
    padding: 16,
    marginTop: 8
  },
  ok: {
    backgroundColor: "#dcfce7"
  },
  waiting: {
    backgroundColor: "#fee2e2"
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827"
  },
  statusText: {
    fontSize: 14,
    marginTop: 8,
    color: "#1f2937"
  },
  metrics: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4
  },
  metricCard: {
    flex: 1,
    backgroundColor: "#e2e8f0",
    borderRadius: 12,
    padding: 12
  },
  metricTitle: {
    fontSize: 12,
    color: "#1e293b"
  },
  metricValue: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: "700",
    color: "#0f172a"
  }
});
