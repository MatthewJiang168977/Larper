package platform

import (
	"log/slog"
	"math/rand/v2"
	"time"
)

// Outage tracks one retry loop's run of consecutive failures, so a short database or broker
// restart (a node reboot, a Postgres image roll) retries quietly instead of sending an
// Error, and so a Sentry event, every few seconds.
//
// Each failure logs Warn (stdout only) and returns how long to wait, backing off from Min to
// Max with jitter. Once the run has lasted After, it logs one Error, which Sentry gets,
// and no more until the loop recovers. The first success after that logs Info "recovered".
// The Error's message is fixed per loop, so Sentry groups a whole outage into one issue.
type Outage struct {
	Name  string        // the loop, e.g. "relay batch": messages are "<Name> failing" and so on
	After time.Duration // report as an Error once failing this long (default 2 minutes)
	Min   time.Duration // first wait (default 2s)
	Max   time.Duration // longest wait (default 30s)

	now      func() time.Time // tests
	jitter   func() float64   // tests: in [0, 1)
	since    time.Time
	failures int
	reported bool
}

func (o *Outage) clock() time.Time {
	if o.now != nil {
		return o.now()
	}
	return time.Now()
}

// Fail records a failure and returns how long to wait before retrying.
func (o *Outage) Fail(log *slog.Logger, err error) time.Duration {
	now := o.clock()
	if o.failures == 0 {
		o.since = now
	}
	o.failures++
	after := o.After
	if after <= 0 {
		after = 2 * time.Minute
	}
	down := now.Sub(o.since)
	if !o.reported && down >= after {
		o.reported = true
		log.Error(o.Name+" failing", "err", err, "for", down.Round(time.Second).String(), "attempts", o.failures)
	} else {
		log.Warn(o.Name+" failed; retrying", "err", err, "attempt", o.failures)
	}
	return o.backoff()
}

// OK records a success. After a reported outage it logs that the loop recovered.
func (o *Outage) OK(log *slog.Logger) {
	if o.failures == 0 {
		return
	}
	if o.reported {
		log.Info(o.Name+" recovered", "for", o.clock().Sub(o.since).Round(time.Second).String(), "attempts", o.failures)
	}
	o.failures, o.reported = 0, false
}

func (o *Outage) backoff() time.Duration {
	lo, hi := o.Min, o.Max
	if lo <= 0 {
		lo = 2 * time.Second
	}
	if hi < lo {
		hi = 30 * time.Second
		if hi < lo {
			hi = lo
		}
	}
	d := lo
	for i := 1; i < o.failures && d < hi; i++ {
		d *= 2
	}
	if d > hi {
		d = hi
	}
	j := rand.Float64
	if o.jitter != nil {
		j = o.jitter
	}
	// 80% to 100% of the step, so replicas that failed together don't retry in lockstep.
	return time.Duration(float64(d) * (0.8 + 0.2*j()))
}
