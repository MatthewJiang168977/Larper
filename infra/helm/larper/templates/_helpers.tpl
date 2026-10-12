{{- define "larper.labels" -}}
app.kubernetes.io/part-of: larper
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
