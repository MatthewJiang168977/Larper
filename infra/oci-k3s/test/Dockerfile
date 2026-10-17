# A stand-in for the Oracle A1 VM: Ubuntu 24.04 booting systemd, with what Oracle's
# image adds that bootstrap.sh has to cope with (iptables rules ending in REJECT,
# loaded by iptables-persistent; cloud-init's sshd drop-in; passwordless sudo for
# "ubuntu"). Runs privileged so k3s can manage iptables, cgroups and mounts.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN echo "iptables-persistent iptables-persistent/autosave_v4 boolean false" | debconf-set-selections \
 && echo "iptables-persistent iptables-persistent/autosave_v6 boolean false" | debconf-set-selections \
 && apt-get update -q \
 && apt-get install -q -y --no-install-recommends systemd systemd-sysv dbus openssh-server sudo \
      iptables iptables-persistent ca-certificates curl kmod iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 # Units that make no sense in a container.
 && systemctl mask getty.target systemd-logind.service systemd-udevd.service \
      systemd-udevd-control.socket systemd-udevd-kernel.socket \
 && systemctl enable ssh.service netfilter-persistent.service

COPY oracle-rules.v4 /etc/iptables/rules.v4
COPY oracle-rules.v6 /etc/iptables/rules.v6

# cloud-init's drop-in turns passwords on in this stand-in, so the test proves that
# bootstrap.sh's 00-larper.conf wins over it.
RUN printf 'PasswordAuthentication yes\n' >/etc/ssh/sshd_config.d/50-cloud-init.conf \
 && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-cloud-init-users \
 && echo 'ubuntu:not-a-real-password' | chpasswd \
 && install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
COPY --chown=ubuntu:ubuntu --chmod=600 authorized_keys /home/ubuntu/.ssh/authorized_keys

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
