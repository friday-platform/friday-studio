package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
	"github.com/tempestteam/atlas/apps/bounce/service"
	"github.com/tempestteam/atlas/pkg/server"
)

func main() {
	var err error

	if os.Getenv("DOT_ENV") != "" {
		err := godotenv.Load(os.Getenv("DOT_ENV"))
		if err != nil {
			fmt.Printf("no .env file found at - %s, using env vars\n", os.Getenv("DOT_ENV"))
		}
	} else {
		err := godotenv.Load()
		if err != nil {
			fmt.Println("no .env file found, using env vars")
		}
	}

	cfg := service.Config{
		TLSConfig: &server.TLSConfig{},
	}
	opts := env.Options{}
	if err := env.ParseWithOptions(&cfg, opts); err != nil {
		panic(err)
	}

	svc := service.New(cfg)

	err = svc.Init()
	if err != nil {
		svc.Logger.Error("Failed to initialize service", "error", err)
		os.Exit(1)
	}

	// Set up signal handling for graceful operations
	signalChan := make(chan os.Signal, 1)
	signal.Notify(signalChan, syscall.SIGHUP)

	go func() {
		for {
			sig := <-signalChan
			if sig == syscall.SIGHUP {
				svc.Logger.Info("Received SIGHUP signal")
			}
		}
	}()

	err = svc.Serve()
	if err != nil {
		svc.Logger.Error("Failed to serve", "error", err)
		os.Exit(1)
	}
}
