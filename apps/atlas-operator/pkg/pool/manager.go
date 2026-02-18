package pool

import (
	"context"
	"log/slog"

	"github.com/prometheus/client_golang/prometheus"
)

// DatabaseClient defines the database operations needed by the pool manager.
type DatabaseClient interface {
	CountPoolUsers(ctx context.Context) (int, error)
	CreatePoolUser(ctx context.Context) (userID string, err error)
}

// Manager handles pool user lifecycle.
type Manager struct {
	db         DatabaseClient
	targetSize int
	logger     *slog.Logger

	poolUsersTotal     prometheus.Gauge
	poolReplenishTotal prometheus.Counter
}

// NewManager creates a new pool manager.
func NewManager(db DatabaseClient, targetSize int, logger *slog.Logger) *Manager {
	poolUsersTotal := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "atlas_operator_pool_users_total",
		Help: "Number of available pool users",
	})
	poolReplenishTotal := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "atlas_operator_pool_replenished_total",
		Help: "Total number of pool users created",
	})

	_ = prometheus.Register(poolUsersTotal)
	_ = prometheus.Register(poolReplenishTotal)

	return &Manager{
		db:                 db,
		targetSize:         targetSize,
		logger:             logger,
		poolUsersTotal:     poolUsersTotal,
		poolReplenishTotal: poolReplenishTotal,
	}
}

// Replenish creates pool users until the target size is reached.
// Returns the number of users created.
func (m *Manager) Replenish(ctx context.Context) (int, error) {
	count, err := m.db.CountPoolUsers(ctx)
	if err != nil {
		return 0, err
	}

	m.poolUsersTotal.Set(float64(count))

	deficit := m.targetSize - count
	if deficit <= 0 {
		return 0, nil
	}

	m.logger.Info("Replenishing pool", "current", count, "target", m.targetSize, "deficit", deficit)

	for i := range deficit {
		if _, err := m.db.CreatePoolUser(ctx); err != nil {
			m.logger.Error("Failed to create pool user", "error", err, "created", i)
			return i, err
		}
		m.poolReplenishTotal.Inc()
	}

	m.poolUsersTotal.Add(float64(deficit))
	m.logger.Info("Pool replenishment completed", "created", deficit)

	return deficit, nil
}
