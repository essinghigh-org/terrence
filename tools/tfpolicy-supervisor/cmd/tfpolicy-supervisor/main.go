package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"terrence.tools/tfpolicy-supervisor/internal/bootstrap"
)

func main() {
	if len(os.Args) != 4 || os.Args[1] != "serve" || os.Args[2] != "--config" {
		fmt.Fprintln(os.Stderr, "usage: tfpolicy-supervisor serve --config /private/run.json")
		os.Exit(2)
	}
	c, e := bootstrap.LoadConfig(os.Args[3])
	if e == nil {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		e = bootstrap.Serve(ctx, c)
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, "tfpolicy bootstrap failed:", e)
		os.Exit(1)
	}
}
