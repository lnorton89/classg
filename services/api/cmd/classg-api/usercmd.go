package main

// Account administration from the box itself.
//
// The web app creates the FIRST administrator and an administrator creates
// everyone else, which leaves one gap with no way out of it: a unit whose only
// admin account is locked, disabled, or forgotten has no console recovery, no
// default password, and no way back in. That is the correct default for a
// detector that may sit on an open network, and it is also how somebody ends
// up reflashing a Pi over a typo.
//
// This is the way back in, and it is deliberately narrow. It runs as a
// subcommand of the server binary, so it shares exactly one definition of what
// a user is, one password hasher, and one store -- rather than a second tool
// with its own copy of any of them. It has no `delete` and no way to read a
// password back out: removing an account is administration, it goes through
// the admin API where it is authenticated and where the last-admin guard
// lives.
//
// A password is never an argument. Command lines are visible in `ps` to every
// user on the box and land in shell history, so it comes from stdin or is
// generated here and printed once.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/classg/api/internal/auth"
	"github.com/classg/api/internal/config"
	"github.com/classg/api/internal/store"
)

const userUsage = `classg-api user <command>

  add    --username U [--display D] [--role viewer|operator|admin] [--password-stdin]
  list
  passwd --username U [--password-stdin]

Without --password-stdin, a strong password is generated and printed once.
Passwords are never taken as arguments: a command line is visible in ps and
kept in shell history.

Reads the same configuration the server does, so run it wherever the server
runs -- in the container, if that is where the database is:

  docker exec -i classg-api classg-api user list
`

// runUser is the `user` subcommand. args excludes the program name and "user".
func runUser(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, userUsage)
		return errors.New("user: no command given")
	}

	sub, rest := args[0], args[1:]
	fs := flag.NewFlagSet("user "+sub, flag.ContinueOnError)
	username := fs.String("username", "", "account name")
	display := fs.String("display", "", "display name; defaults to the username")
	roleName := fs.String("role", "viewer", "viewer, operator or admin")
	fromStdin := fs.Bool("password-stdin", false, "read the password from stdin instead of generating one")
	if err := fs.Parse(rest); err != nil {
		return err
	}

	switch sub {
	case "add", "list", "passwd":
	case "-h", "--help", "help":
		fmt.Print(userUsage)
		return nil
	default:
		fmt.Fprint(os.Stderr, userUsage)
		return fmt.Errorf("user: unknown command %q", sub)
	}

	svc, closeStore, err := openAuthService()
	if err != nil {
		return err
	}
	defer closeStore()

	// Not the server's signal-aware context: this is a short synchronous
	// command, and a Ctrl-C mid-write is worse than one that finishes.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch sub {
	case "list":
		return listUsers(ctx, svc)
	case "add":
		return addUser(ctx, svc, *username, *display, *roleName, *fromStdin)
	default:
		return setUserPassword(ctx, svc, *username, *fromStdin)
	}
}

// openAuthService builds the same store and the same auth service the server
// builds, from the same configuration.
//
// Mode is forced on. The server honours CLASSG_AUTH_MODE=off, and creating an
// account is exactly what somebody does to turn authentication back on -- a
// tool that refused because authentication was currently disabled would be
// refusing the one job it exists for.
func openAuthService() (*auth.Service, func(), error) {
	if _, err := config.LoadDotEnv(); err != nil {
		return nil, nil, err
	}
	boot, err := config.BootstrapFromEnv()
	if err != nil {
		return nil, nil, err
	}
	if boot.Store == config.StoreMemory {
		return nil, nil, errors.New(
			"CLASSG_STORE=memory: an account created here would vanish with this process")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	st, err := openStore(ctx, boot)
	if err != nil {
		return nil, nil, err
	}

	svc := &auth.Service{
		Store: st,
		Mode:  auth.ModeRequired,
		Now:   func() time.Time { return time.Now().UTC() },
	}
	return svc, func() { _ = st.Close() }, nil
}

func listUsers(ctx context.Context, svc *auth.Service) error {
	users, err := svc.Store.ListUsers(ctx)
	if err != nil {
		return err
	}
	if len(users) == 0 {
		fmt.Println("no accounts yet; the web app creates the first administrator")
		return nil
	}
	fmt.Printf("%-20s %-10s %-8s %s\n", "USERNAME", "ROLE", "STATE", "CREATED")
	for _, u := range users {
		state := "active"
		if u.Disabled {
			state = "disabled"
		}
		fmt.Printf("%-20s %-10s %-8s %s\n",
			u.Username, u.Role.String(), state, u.CreatedAt.Format(time.RFC3339))
	}
	return nil
}

func addUser(ctx context.Context, svc *auth.Service, username, display, roleName string, fromStdin bool) error {
	if strings.TrimSpace(username) == "" {
		return errors.New("--username is required")
	}
	role, err := auth.ParseRole(roleName)
	if err != nil {
		return fmt.Errorf("--role: %w", err)
	}

	password, generated, err := readOrGeneratePassword(fromStdin)
	if err != nil {
		return err
	}

	u, err := svc.CreateUser(ctx, username, display, password, role)
	if err != nil {
		return err
	}

	fmt.Printf("created %s (%s)\n", u.Username, u.Role.String())
	if generated {
		announceGeneratedPassword(password)
	}
	return nil
}

func setUserPassword(ctx context.Context, svc *auth.Service, username string, fromStdin bool) error {
	if strings.TrimSpace(username) == "" {
		return errors.New("--username is required")
	}
	u, err := svc.Store.GetUserByUsername(ctx, username)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no account called %q", username)
	}
	if err != nil {
		return err
	}

	password, generated, err := readOrGeneratePassword(fromStdin)
	if err != nil {
		return err
	}

	// keepSession empty: every existing session for this account is revoked.
	// A password reset from the box is what somebody does when they think an
	// account is compromised, and leaving the attacker's session alive would
	// make it ceremonial.
	if err := svc.SetPassword(ctx, u.UserID, password, ""); err != nil {
		return err
	}

	fmt.Printf("password changed for %s; existing sessions revoked\n", u.Username)
	if generated {
		announceGeneratedPassword(password)
	}
	return nil
}

func readOrGeneratePassword(fromStdin bool) (password string, generated bool, err error) {
	if !fromStdin {
		p, err := generatePassword()
		return p, true, err
	}
	raw, err := io.ReadAll(bufio.NewReader(os.Stdin))
	if err != nil {
		return "", false, fmt.Errorf("reading the password from stdin: %w", err)
	}
	// One trailing newline, from `echo` or a heredoc, is not part of the
	// password. Nothing else is trimmed: leading and trailing spaces inside a
	// passphrase are the user's business.
	return strings.TrimRight(string(raw), "\r\n"), false, nil
}

// generatePassword returns 160 bits of randomness, which is past anything an
// argon2id verifier will ever be the bottleneck for.
func generatePassword() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generating a password: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// announceGeneratedPassword prints it to stdout, once, with the fact that it
// is not recoverable. It is not logged and not stored anywhere in plaintext --
// the database holds an argon2id hash and nothing else.
func announceGeneratedPassword(password string) {
	fmt.Printf("\n  password: %s\n\n", password)
	fmt.Println("Shown once. Nothing stores it in plaintext, so a lost one is reset, not recovered.")
}
