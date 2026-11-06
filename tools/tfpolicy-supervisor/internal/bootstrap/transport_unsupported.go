//go:build !linux

package bootstrap

import (
	"context"
	"errors"
	"io"
)

var errLinuxRequired = errors.New("tfpolicy bootstrap requires native Linux SO_PEERCRED and trusted procfs")

func LoadConfig(string) (Config, error)                          { return Config{}, errLinuxRequired }
func Serve(context.Context, Config) error                        { return errLinuxRequired }
func RunShim(context.Context, string, []string, io.Writer) error { return errLinuxRequired }
