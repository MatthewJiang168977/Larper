{{- define "larper.labels" -}}
app.kubernetes.io/part-of: larper
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Env shared by the Go workers. */}}
{{- define "larper.workerEnv" -}}
- { name: KAFKA_BROKERS, value: "redpanda:9092" }
- name: DATABASE_URL
  valueFrom: { secretKeyRef: { name: pg-app, key: uri } }
{{- end -}}
