{{- define "larper.labels" -}}
app.kubernetes.io/part-of: larper
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The Postgres login roles besides the owner: values key -> role name. The services'
(migration 0010 grants them what they need), the backup check's, which needs no
grant at all (templates/backup-check.yaml), so only CNPG's managed roles create it,
and the demo reset's (migration 0012; templates/demo-reset.yaml).
*/}}
{{- define "larper.dbRoles" -}}
api: larper_api
relay: larper_relay
taste: larper_taste
ingest: larper_ingest
backup-check: larper_backup_check
demo-reset: larper_demo_reset
{{- end -}}

{{/*
The demo account's settings (demo.*), for the API and the demo-reset CronJob. The
Clerk secret key and the user's id come from the Secret demo.secretName, created
outside the chart (scripts/oci-up.sh, from apps/web/.env.local and the demo env file).
*/}}
{{- define "larper.demoEnv" -}}
- name: CLERK_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.demo.secretName }}, key: secretKey } }
- name: DEMO_CLERK_USER_ID
  valueFrom: { secretKeyRef: { name: {{ .Values.demo.secretName }}, key: userId } }
- { name: DEMO_EMAIL, value: {{ required "demo.email is required with demo.enabled" .Values.demo.email | quote }} }
{{- end -}}

{{/*
A service's connection to Postgres, as its own role: user and password from its
Secret (templates/db-roles.yaml), host and database as in CNPG's pg-app URI. The
password is expanded into DATABASE_URL by the kubelet at container start, so it is
never in the pod spec. The Go workers' pool size goes in the URL (pgx reads
pool_max_conns); the API reads DB_POOL_MAX.
Call with (dict "root" $ "role" "api").
*/}}
{{- define "larper.dbEnv" -}}
{{- $pool := (index .root.Values.postgres.roles .role).pool -}}
- name: DB_USER
  valueFrom: { secretKeyRef: { name: pg-{{ .role }}, key: username } }
- name: DB_PASSWORD
  valueFrom: { secretKeyRef: { name: pg-{{ .role }}, key: password } }
{{- if eq .role "api" }}
- { name: DB_POOL_MAX, value: {{ $pool | quote }} }
- name: DATABASE_URL
  value: "postgresql://$(DB_USER):$(DB_PASSWORD)@pg-rw.{{ .root.Release.Namespace }}:5432/larper"
{{- else }}
- name: DATABASE_URL
  value: "postgresql://$(DB_USER):$(DB_PASSWORD)@pg-rw.{{ .root.Release.Namespace }}:5432/larper?pool_max_conns={{ $pool }}"
{{- end }}
{{- end -}}

{{/* Env shared by the Go workers. Call with (dict "root" $ "role" "relay"). */}}
{{- define "larper.workerEnv" -}}
- { name: KAFKA_BROKERS, value: "redpanda:9092" }
{{ include "larper.dbEnv" . }}
{{- end -}}

{{/*
Most pods a Deployment can run at once: its replicas (the HPA's max for the API)
plus the default rolling update's surge, 25% rounded up. The relay is Recreate.
*/}}
{{- define "larper.surge" -}}
{{- add . (div (add . 3) 4) -}}
{{- end -}}

{{/*
Refuses to render when a role's connection limit can't cover its pods at full scale:
a pod past the limit gets "too many connections for role" instead of a pool slot.
And when the limits together don't fit in max_connections.
*/}}
{{- define "larper.checkConnections" -}}
{{- $v := .Values -}}
{{- $r := $v.postgres.roles -}}
{{- $apiMax := ternary $v.api.hpa.maxReplicas $v.api.replicas $v.api.hpa.enabled | int -}}
{{- $pods := dict
  "api" (include "larper.surge" $apiMax | int)
  "relay" 1
  "taste" (include "larper.surge" ($v.workers.tasteReplicas | int) | int)
  "ingest" (add1 (include "larper.surge" ($v.ingest.replicas | int) | int)) -}}
{{- range $role, $n := $pods }}
{{- $c := index $r $role }}
{{- $need := mul $c.pool $n }}
{{- if lt (int $c.connectionLimit) (int $need) }}
{{- fail (printf "postgres.roles.%s.connectionLimit is %v, below pool (%v) x pods (%v) = %v: the most %s pods this profile can run (replicas or the HPA's max, plus a rollout's surge%s) would be refused connections" $role $c.connectionLimit $c.pool $n $need $role (ternary ", plus one load-places run" "" (eq $role "ingest"))) }}
{{- end }}
{{- end }}
{{- $total := add $r.owner.connectionLimit $r.api.connectionLimit $r.relay.connectionLimit $r.taste.connectionLimit $r.ingest.connectionLimit (index $r "backup-check").connectionLimit (index $r "demo-reset").connectionLimit $v.postgres.reservedConnections -}}
{{- $max := int (default "100" (get $v.postgres.parameters "max_connections")) -}}
{{- if gt (int $total) $max }}
{{- fail (printf "the roles' connection limits plus postgres.reservedConnections add up to %v, over max_connections (%v): raise postgres.parameters.max_connections or lower the limits" $total $max) }}
{{- end }}
{{- end -}}


{{/*
api.cors.origins, checked and comma-joined. Refuses to render a wildcard or anything
but an exact origin, and an origin missing from clerk.authorizedParties: its calls
would pass CORS and then fail the token's azp check.
*/}}
{{- define "larper.corsOrigins" -}}
{{- $parties := splitList "," (.Values.clerk.authorizedParties | nospace) -}}
{{- range .Values.api.cors.origins }}
{{- if not (regexMatch "^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$" .) }}
{{- fail (printf "api.cors.origins: %q is not an origin (scheme://host[:port], no path, no wildcard)" .) }}
{{- end }}
{{- if not (has . $parties) }}
{{- fail (printf "api.cors.origins: %q isn't in clerk.authorizedParties, so its requests would be rejected; add it there too" .) }}
{{- end }}
{{- end }}
{{- join "," .Values.api.cors.origins -}}
{{- end -}}
