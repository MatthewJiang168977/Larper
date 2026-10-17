#!/usr/bin/env bash
# Prepares the Oracle A1 VM (Ubuntu 24.04) as a single-node k3s host. Run as root on
# the VM; scripts/oci-up.sh copies it over and runs it. Safe to re-run.
#
#   1. OS updates now, then unattended security updates (reboot at 04:30 if needed)
#   2. SSH: keys only, no root login, no passwords
#   3. k3s, pinned, with secrets encryption
#   4. Host firewall: inbound SSH only (plus what k3s needs inside the node), last
#
# Two firewalls guard the VM. The VCN security list (created by
# scripts/oci-capacity-probe.sh) allows TCP 22 and ICMP 3/4 only. The host firewall
# is Oracle's iptables rules, which also allow only SSH but end INPUT and FORWARD
# with REJECT, which breaks k3s pod networking. This script keeps Oracle's rules
# (including its 169.254.x instance-services rules) and replaces those two REJECTs
# with: accept traffic to and from the pod network, then DROP everything else. A
# mangle-table guard drops new non-SSH connections from outside before Kubernetes's
# own rules can forward them to a pod (Traefik's ports, NodePorts).
#
# Firewall changes arm a rollback: unless `systemctl stop larper-fw-rollback.timer`
# runs within 3 minutes (oci-up.sh does it over a NEW SSH connection, proving SSH
# still works), the previous rules are restored.
set -euo pipefail

K3S_VERSION=${K3S_VERSION:-v1.35.5+k3s1}
POD_CIDR=10.42.0.0/16 # k3s defaults
RULES=/etc/iptables/rules.v4
RULES6=/etc/iptables/rules.v6
ORACLE_RULES=/etc/iptables/rules.v4.oracle
TEST=${BOOTSTRAP_TEST:-0} # 1: skip systemd, k3s and the live firewall (container tests)

log() { echo "==> $*"; }
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# --- 1. updates -----------------------------------------------------------------
log "OS updates"
apt-get update -q
apt-get -q -y -o Dpkg::Options::=--force-confold upgrade
# iptables-persistent loads /etc/iptables/rules.v{4,6} at boot. Don't let it save the
# live rules on install: k3s adds its own at runtime, and those must not be persisted.
echo "iptables-persistent iptables-persistent/autosave_v4 boolean false" | debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean false" | debconf-set-selections
apt-get -q -y install unattended-upgrades iptables-persistent curl

log "unattended security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Ubuntu's 50unattended-upgrades already limits this to the -security pocket (and
# ESM). A kernel update needs a reboot; k3s and every pod come back on their own.
cat >/etc/apt/apt.conf.d/52larper-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

# --- 2. SSH -------------------------------------------------------------------------
log "SSH: keys only, no root"
# sshd keeps the first value it reads, and drop-ins are read in order: 00- wins over
# cloud-init's 50-cloud-init.conf.
cat >/etc/ssh/sshd_config.d/00-larper.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
X11Forwarding no
MaxAuthTries 3
EOF
mkdir -p /run/sshd
sshd -t # a broken config must never reach a reload
[[ $TEST == 1 ]] || systemctl reload ssh

# --- 3. k3s ------------------------------------------------------------------------
# Before the firewall: the firewall's rollback window (3 min) must only have to cover
# oci-up.sh's confirming SSH connection, not a k3s download. Oracle's REJECT rules
# don't stop the node going Ready (kubelet reaches the API server over lo).
if [[ $TEST == 1 ]]; then
  log "test mode: skipping k3s"
elif [[ "$(k3s --version 2>/dev/null | head -1)" == *"$K3S_VERSION"* ]]; then
  log "k3s $K3S_VERSION already installed"
else
  log "installing k3s $K3S_VERSION"
  # The installer verifies the binary's sha256. Built-in Traefik, metrics-server and
  # local-path storage stay on: the chart uses all three. The API server (6443) is
  # closed by both firewalls; kubectl goes through an SSH tunnel.
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" \
    INSTALL_K3S_EXEC="server --write-kubeconfig-mode 600 --secrets-encryption" sh -
fi
if [[ $TEST != 1 ]]; then
  for _ in $(seq 1 60); do
    k3s kubectl get node 2>/dev/null | grep -q ' Ready ' && break
    sleep 5
  done
  k3s kubectl get node
fi

# --- 4. host firewall ---------------------------------------------------------------
log "host firewall: inbound SSH only"
mkdir -p /etc/iptables
[[ -f $ORACLE_RULES ]] || { [[ -f $RULES ]] && cp "$RULES" "$ORACLE_RULES"; } || true

# The tail added to the filter table: pod network in, everything else dropped.
ours() {
  cat <<EOF
-A INPUT -s $POD_CIDR -m comment --comment "larper: k3s pods to this node (kubelet, API server, DNS)" -j ACCEPT
-A INPUT -i cni0 -m comment --comment "larper: k3s pod bridge" -j ACCEPT
-A INPUT -m comment --comment "larper: drop everything else" -j DROP
-A FORWARD -s $POD_CIDR -m comment --comment "larper: pod traffic out" -j ACCEPT
-A FORWARD -d $POD_CIDR -m comment --comment "larper: pod traffic in" -j ACCEPT
-A FORWARD -m comment --comment "larper: drop everything else" -j DROP
EOF
}
# The filter rules above can't stop traffic that Kubernetes forwards to a pod: k3s's
# service load balancer (and any NodePort or hostPort) DNATs it in nat PREROUTING, and
# kube-router and kube-proxy ACCEPT it in FORWARD ahead of our rules. mangle
# PREROUTING runs before both, so new connections to this node from outside the pod
# network are dropped there unless they are SSH, whatever Kubernetes opens later.
guard() {
  cat <<EOF
*mangle
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
-A PREROUTING ! -i lo ! -s $POD_CIDR -m addrtype --dst-type LOCAL -p tcp -m conntrack --ctstate NEW ! --dport 22 -m comment --comment "larper: only SSH reaches this node from outside" -j DROP
-A PREROUTING ! -i lo ! -s $POD_CIDR -m addrtype --dst-type LOCAL -p udp -m conntrack --ctstate NEW -m comment --comment "larper: no inbound UDP from outside" -j DROP
COMMIT
EOF
}
new=$(mktemp)
if [[ -f $ORACLE_RULES ]] && grep -q -- '--dport 22' "$ORACLE_RULES"; then
  # Oracle's rules minus the INPUT/FORWARD REJECTs, plus ours at the end of *filter.
  awk -v tail="$(ours)" '
    /^\*filter/ { infilter = 1 }
    infilter && /^-A (INPUT|FORWARD) .*-j REJECT/ { next }
    infilter && /^COMMIT/ { print tail; infilter = 0 }
    { print }
  ' "$ORACLE_RULES" >"$new"
else
  # Not Oracle's image layout: a complete minimal ruleset instead.
  {
    echo '*filter'
    echo ':INPUT ACCEPT [0:0]'
    echo ':FORWARD ACCEPT [0:0]'
    echo ':OUTPUT ACCEPT [0:0]'
    echo '-A INPUT -i lo -j ACCEPT'
    echo '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT'
    echo '-A INPUT -p icmp --icmp-type destination-unreachable -j ACCEPT'
    echo '-A INPUT -p tcp -m conntrack --ctstate NEW -m tcp --dport 22 -j ACCEPT'
    ours
    echo 'COMMIT'
  } >"$new"
fi
grep -q '^\*mangle' "$new" && { echo "refusing: $ORACLE_RULES already has a mangle table; merge by hand" >&2; exit 1; }
guard >>"$new"
# The VCN is IPv4-only; IPv6 inbound is dropped except what IPv6 itself needs.
new6=$(mktemp)
cat >"$new6" <<'EOF'
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p ipv6-icmp -j ACCEPT
-A INPUT -p tcp -m conntrack --ctstate NEW -m tcp --dport 22 -j ACCEPT
COMMIT
EOF

# Sanity: SSH is still allowed and nothing else is opened.
grep -qE -- '^-A INPUT .*--dport 22 .*-j ACCEPT' "$new" || { echo "refusing: new rules don't allow SSH" >&2; exit 1; }
if grep -E '^-A INPUT .*--dport ' "$new" | grep -v -- '--dport 22 ' | grep -q ACCEPT; then
  echo "refusing: new rules open a port other than 22:" >&2
  grep -E '^-A INPUT .*--dport ' "$new" | grep -v -- '--dport 22 ' >&2
  exit 1
fi
iptables-restore --test <"$new"
ip6tables-restore --test <"$new6"

if cmp -s "$new" "$RULES" 2>/dev/null && cmp -s "$new6" "$RULES6" 2>/dev/null; then
  log "firewall rules unchanged"
  rm -f "$new" "$new6"
else
  [[ -f $RULES ]] && cp "$RULES" "$RULES.prev"
  [[ -f $RULES6 ]] && cp "$RULES6" "$RULES6.prev"
  install -m 0640 "$new" "$RULES"
  install -m 0640 "$new6" "$RULES6"
  rm -f "$new" "$new6"
  if [[ $TEST != 1 ]]; then
    iptables-save >/root/iptables.before
    ip6tables-save >/root/ip6tables.before
    systemctl stop larper-fw-rollback.timer 2>/dev/null || true
    systemctl reset-failed larper-fw-rollback.service 2>/dev/null || true # else systemd-run refuses the name
    # Restoring flushes k3s's chains too, so the rollback restarts k3s like below.
    systemd-run --quiet --unit larper-fw-rollback --on-active=180 /bin/sh -c \
      "iptables-restore </root/iptables.before; ip6tables-restore </root/ip6tables.before; \
       [ -f $RULES.prev ] && cp $RULES.prev $RULES; [ -f $RULES6.prev ] && cp $RULES6.prev $RULES6; \
       systemctl is-active --quiet k3s && systemctl restart k3s; true"
    # Restoring the filter table flushes k3s's own chains; restarting k3s re-adds them.
    iptables-restore <"$RULES"
    ip6tables-restore <"$RULES6"
    systemctl is-active --quiet k3s && systemctl restart k3s
    log "firewall applied; rollback in 3 min unless: systemctl stop larper-fw-rollback.timer"
  fi
fi
log "bootstrap done"
