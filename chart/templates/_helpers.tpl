{{/*
Expand the name of the chart.
*/}}
{{- define "janus-inference-control-plane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this
(by the DNS naming spec). If the release name contains the chart name it will
be used as the full name.
*/}}
{{- define "janus-inference-control-plane.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart labels.
*/}}
{{- define "janus-inference-control-plane.labels" -}}
helm.sh/chart: {{ include "janus-inference-control-plane.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "janus-inference-control-plane.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "janus-inference-control-plane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "janus-inference-control-plane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
