-- Takes back 0012's grants. The role stays: CloudNativePG manages it (see 0010's down).
REVOKE ALL ON users, quests FROM larper_demo_reset;
REVOKE USAGE ON SCHEMA public FROM larper_demo_reset;
