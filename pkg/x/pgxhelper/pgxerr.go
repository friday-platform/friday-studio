package pgxhelper

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Expect struct {
	log *slog.Logger
	ctx context.Context
}

type ExpectError struct {
	Err  error
	Code string
}

func (e *ExpectError) Error() string {
	return e.Err.Error()
}

type ExpectOpt func(*Expect)

func WithContext(ctx context.Context) ExpectOpt {
	return func(e *Expect) {
		e.ctx = ctx
	}
}

func WithLog(log *slog.Logger) ExpectOpt {
	return func(e *Expect) {
		e.log = log
	}
}

func NewExpectation(opts ...ExpectOpt) *Expect {
	config := &Expect{}

	for _, opt := range opts {
		opt(config)
	}

	// if config.Log == nil we initialize a no-op logger
	if config.log == nil {
		config.log = slog.New(slog.NewTextHandler(nil, nil))
	}

	if config.ctx == nil {
		config.ctx = context.Background()
	}

	return config
}

func (e *Expect) ExactlyOneRow(err error) *ExpectError {
	log := e.log
	if err == nil {
		return nil
	}

	var ee *ExpectError

	var pgxErr *pgconn.PgError

	if errors.As(err, &pgxErr) {
		switch pgxErr.Code {
		case "23505":
			log.Error("Unique constraint violation", "error", err)
			ee = &ExpectError{Err: err, Code: "23505"}
		case "23503":
			log.Error("Foreign key constraint violation", "error", err)
			ee = &ExpectError{Err: err, Code: "23503"}
		case "23514":
			log.Error("Check constraint violation", "error", err)
			ee = &ExpectError{Err: err, Code: "23514"}
		case "23502":
			log.Error("Not null constraint violation", "error", err)
			ee = &ExpectError{Err: err, Code: "23502"}
		}
	}

	if ee != nil {
		return ee
	}

	switch {
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, pgx.ErrNoRows):
		log.Error("Expected exactly one row, but got none")
		ee = &ExpectError{Err: err, Code: "ErrNoRows"}
	case errors.Is(err, pgx.ErrTooManyRows):
		log.Error("Expected exactly one row, but got more")
		ee = &ExpectError{Err: err, Code: "ErrTooManyRows"}
	case errors.Is(err, sql.ErrTxDone), errors.Is(err, pgx.ErrTxClosed):
		log.Error("Transaction closed", "error", err)
		ee = &ExpectError{Err: err, Code: "ErrTxClosed"}
	case errors.Is(err, sql.ErrConnDone):
		log.Error("Connection closed", "error", err)
		ee = &ExpectError{Err: err, Code: "ErrConnDone"}
	default:
		log.Error("Error checking for exactly one row", "error", err)
		ee = &ExpectError{Err: err, Code: "ErrInternal"}
	}

	return ee
}

func (e *Expect) Commit(tx pgx.Tx) error {
	err := tx.Commit(e.ctx)
	if err != nil {
		e.log.Error("error committing transaction", "error", err)
	}
	return err
}

func (e *Expect) DeferRollbackRelease(tx pgx.Tx, conn *pgxpool.Conn) {
	if conn == nil {
		return
	}
	defer conn.Release()

	if tx == nil {
		return
	}

	err := tx.Rollback(e.ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrTxClosed) {
			return
		}
	}
}

func (e *Expect) Rollback(tx pgx.Tx) {
	if tx == nil {
		return
	}

	err := tx.Rollback(e.ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrTxClosed) {
			return
		}
	}
}
