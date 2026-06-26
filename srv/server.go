package srv

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"srv.exe.dev/db"
)

type Server struct {
	DB        *sql.DB
	Hostname  string
	StaticDir string

	autoMu    sync.Mutex
	autoTimer *time.Timer
}

// scheduleAutosave debounces autosave snapshots so a burst of edits (a paint
// stroke) collapses into one snapshot a few seconds after activity settles.
func (s *Server) scheduleAutosave(by, mode string) {
	s.autoMu.Lock()
	defer s.autoMu.Unlock()
	if s.autoTimer != nil {
		s.autoTimer.Stop()
	}
	s.autoTimer = time.AfterFunc(4*time.Second, func() { s.autosaveSnapshot(by, mode) })
}

func New(dbPath, hostname string) (*Server, error) {
	_, thisFile, _, _ := runtime.Caller(0)
	baseDir := filepath.Dir(thisFile)
	s := &Server{Hostname: hostname, StaticDir: filepath.Join(baseDir, "static")}
	if err := s.setUpDatabase(dbPath); err != nil {
		return nil, err
	}
	if err := s.seedIfNeeded(); err != nil {
		slog.Warn("seed", "error", err)
	}
	return s, nil
}

func (s *Server) setUpDatabase(dbPath string) error {
	wdb, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	s.DB = wdb
	if err := db.RunMigrations(wdb); err != nil {
		return fmt.Errorf("migrations: %w", err)
	}
	return nil
}

// ---- meta helpers ----

func (s *Server) getMeta(key string) (string, bool) {
	var v string
	err := s.DB.QueryRow("SELECT value FROM meta WHERE key=?", key).Scan(&v)
	if err != nil {
		return "", false
	}
	return v, true
}

func (s *Server) setMeta(key, val string) error {
	_, err := s.DB.Exec("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, val)
	return err
}

func (s *Server) nextRev() (int64, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var cur int64
	if err := tx.QueryRow("SELECT CAST(value AS INTEGER) FROM meta WHERE key='rev'").Scan(&cur); err != nil {
		return 0, err
	}
	cur++
	if _, err := tx.Exec("UPDATE meta SET value=? WHERE key='rev'", strconv.FormatInt(cur, 10)); err != nil {
		return 0, err
	}
	return cur, tx.Commit()
}

// ---- seeding initial land use from static/data/initial.json ----

func (s *Server) seedIfNeeded() error {
	if v, _ := s.getMeta("seeded"); v == "1" {
		return nil
	}
	path := filepath.Join(s.StaticDir, "data", "initial.json")
	bts, err := readFile(path)
	if err != nil {
		slog.Warn("no initial.json to seed", "error", err)
		_ = s.setMeta("seeded", "1")
		return nil
	}
	var init map[string]struct {
		U string `json:"u"`
		W int    `json:"w"`
	}
	if err := json.Unmarshal(bts, &init); err != nil {
		return err
	}
	rev, err := s.nextRev()
	if err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// the seed is the Boma map.
	stmt, err := tx.Prepare("INSERT INTO cells(cell_id,mode,land_use,wildlife,rev,updated_by) VALUES(?,'boma',?,?,?,'seed') ON CONFLICT(mode,cell_id) DO NOTHING")
	if err != nil {
		return err
	}
	n := 0
	for idStr, a := range init {
		id, err := strconv.Atoi(idStr)
		if err != nil {
			continue
		}
		var lu interface{}
		if a.U != "" {
			lu = a.U
		}
		if _, err := stmt.Exec(id, lu, a.W, rev); err != nil {
			return err
		}
		n++
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	_ = s.setMeta("seeded", "1")
	slog.Info("seeded land use", "cells", n)
	return nil
}

// ---- auth ----

// The one secret that unlocks the original Boma / Jonglei land-use data.
// Any other secret signs the user into a blank global map instead.
const bomaSecret = "boma@250626"

const (
	modeBoma   = "boma"
	modeGlobal = "global"
)

// Every distinct secret unlocks its OWN private map (its own cells + versions +
// saved view). The canonical Boma phrase maps to the shared seeded map; any
// other secret derives a stable, opaque mode from a hash of the secret so two
// different secrets can never see, restore, or overwrite each other's work.
func modeForSecret(secret string) string {
	if secret == bomaSecret {
		return modeBoma
	}
	sum := sha256.Sum256([]byte("landuse-mode:" + secret))
	return "s_" + hex.EncodeToString(sum[:])[:16]
}

// claimLegacyGlobal migrates the old single shared 'global' map (cells + versions
// + view) to the first non-boma secret that logs in after this change. Earlier
// builds lumped all non-boma secrets into one 'global' mode; this hands that
// existing work to its (sole active) owner exactly once, then never again.
func (s *Server) claimLegacyGlobal(mode string) {
	if mode == modeBoma || mode == modeGlobal {
		return
	}
	if v, _ := s.getMeta("global_claimed"); v != "" {
		return
	}
	var n int
	_ = s.DB.QueryRow("SELECT COUNT(*) FROM cells WHERE mode=?", modeGlobal).Scan(&n)
	var nv int
	_ = s.DB.QueryRow("SELECT COUNT(*) FROM versions WHERE mode=?", modeGlobal).Scan(&nv)
	if n == 0 && nv == 0 {
		return
	}
	_, _ = s.DB.Exec("UPDATE cells SET mode=? WHERE mode=?", mode, modeGlobal)
	_, _ = s.DB.Exec("UPDATE versions SET mode=? WHERE mode=?", mode, modeGlobal)
	if v, ok := s.getMeta("view:" + modeGlobal); ok {
		_ = s.setMeta("view:"+mode, v)
	}
	_ = s.setMeta("global_claimed", mode)
}

type identity struct {
	OwnerEmail string
	Email      string // exe.dev email of requester
	Name       string // editor name (from cookie)
	Mode       string // boma | global (from cookie)
	IsOwner    bool
	Authed     bool // has a valid signed editor session cookie
}

// signKey is a stable server-side HMAC key for session cookies. It is
// independent of any user secret (users no longer share a single secret).
func (s *Server) signKey() []byte {
	if v, ok := s.getMeta("sign_key"); ok && v != "" {
		if b, err := hex.DecodeString(v); err == nil {
			return b
		}
	}
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	_ = s.setMeta("sign_key", hex.EncodeToString(b))
	return b
}

func (s *Server) sign(payload string) string {
	mac := hmac.New(sha256.New, s.signKey())
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// cookie payload is "name\x1fmode"
func (s *Server) makeCookieValue(name, mode string) string {
	payload := name + "\x1f" + mode
	enc := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return enc + "." + s.sign(payload)
}

func (s *Server) parseCookieValue(val string) (name, mode string, ok bool) {
	parts := strings.SplitN(val, ".", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	nb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", false
	}
	payload := string(nb)
	if !hmac.Equal([]byte(s.sign(payload)), []byte(parts[1])) {
		return "", "", false
	}
	seg := strings.SplitN(payload, "\x1f", 2)
	name = seg[0]
	if len(seg) == 2 {
		mode = seg[1]
	} else {
		mode = modeBoma // legacy cookies
	}
	return name, mode, true
}

func (s *Server) identify(r *http.Request) identity {
	id := identity{}
	id.OwnerEmail, _ = s.getMeta("owner_email")
	id.Email = strings.TrimSpace(r.Header.Get("X-ExeDev-Email"))
	// Record the first exe.dev visitor as the owner (for the admin badge only).
	if id.OwnerEmail == "" && id.Email != "" {
		_ = s.setMeta("owner_email", id.Email)
		id.OwnerEmail = id.Email
	}
	if id.OwnerEmail != "" && id.Email != "" && strings.EqualFold(id.Email, id.OwnerEmail) {
		id.IsOwner = true
	}
	// Authentication is solely the signed session cookie — owner status alone
	// does NOT authenticate, so signing out actually signs you out.
	if c, err := r.Cookie("lu_session"); err == nil {
		if name, mode, ok := s.parseCookieValue(c.Value); ok {
			id.Name = name
			id.Mode = mode
			id.Authed = true
		}
	}
	return id
}

// ---- HTTP ----

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) Serve(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /api/me", s.handleMe)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("POST /api/view", s.handleViewSave)
	mux.HandleFunc("POST /api/update", s.handleUpdate)
	mux.HandleFunc("GET /api/versions", s.handleVersionsList)
	mux.HandleFunc("POST /api/versions", s.handleVersionSave)
	mux.HandleFunc("GET /api/versions/{token}", s.handleVersionGet)
	mux.HandleFunc("POST /api/versions/{token}", s.handleVersionRename)
	mux.HandleFunc("POST /api/versions/{token}/restore", s.handleVersionRestore)
	mux.HandleFunc("GET /api/export", s.handleExport)
	mux.HandleFunc("POST /api/import", s.handleImport)
	mux.Handle("/static/", http.StripPrefix("/static/", s.staticHandler()))
	slog.Info("starting land use editor", "addr", addr)
	return http.ListenAndServe(addr, mux)
}

// serve static, with gzip support for *.json.gz
func (s *Server) staticHandler() http.Handler {
	fs := http.FileServer(http.Dir(s.StaticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// transparently serve grid.json from grid.json.gz when client accepts gzip
		if strings.HasSuffix(r.URL.Path, "data/grid.json") && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			if _, err := readFile(filepath.Join(s.StaticDir, "data", "grid.json.gz")); err == nil {
				w.Header().Set("Content-Encoding", "gzip")
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-transform")
				r.URL.Path = r.URL.Path + ".gz"
			}
		}
		fs.ServeHTTP(w, r)
	})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, filepath.Join(s.StaticDir, "index.html"))
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	writeJSON(w, 200, map[string]interface{}{
		"authed": id.Authed,
		"owner":  id.IsOwner,
		"name":   id.Name,
		"mode":   id.Mode,
		"email":  id.Email,
		"title":  firstNonEmpty(metaOr(s, "title"), "Land Use Zonation"),
		"view":   metaOr(s, "view:"+id.Mode),
	})
}

func metaOr(s *Server, k string) string { v, _ := s.getMeta(k); return v }
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func randToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// handleLogin accepts a name + secret. We don't store a shared secret; the
// secret value alone decides which map you see: the canonical Boma data for
// the magic phrase, or a blank global map for anything else.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct{ Secret, Name string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	if strings.TrimSpace(body.Secret) == "" {
		writeJSON(w, 400, map[string]string{"error": "secret required"})
		return
	}
	mode := modeForSecret(body.Secret)
	s.claimLegacyGlobal(mode)
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = randomEditorName()
	}
	s.setSessionCookie(w, name, mode)
	writeJSON(w, 200, map[string]string{"ok": "1", "name": name, "mode": mode})
}

func (s *Server) setSessionCookie(w http.ResponseWriter, name, mode string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "lu_session",
		Value:    s.makeCookieValue(name, mode),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   60 * 60 * 24 * 180,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "lu_session", Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, 200, map[string]string{"ok": "1"})
}

// ---- state & updates ----

type cellState struct {
	U   string `json:"u,omitempty"`
	W   int    `json:"w,omitempty"`
	Grp string `json:"grp,omitempty"`
	Nt  string `json:"nt,omitempty"`
}

func (s *Server) loadState(mode string) (int64, map[string]cellState, error) {
	var rev int64
	_ = s.DB.QueryRow("SELECT CAST(value AS INTEGER) FROM meta WHERE key='rev'").Scan(&rev)
	rows, err := s.DB.Query("SELECT cell_id, COALESCE(land_use,''), wildlife, COALESCE(grp,''), COALESCE(note,'') FROM cells WHERE mode=? AND (land_use IS NOT NULL OR wildlife=1 OR grp IS NOT NULL OR note IS NOT NULL)", mode)
	if err != nil {
		return rev, nil, err
	}
	defer rows.Close()
	out := map[string]cellState{}
	for rows.Next() {
		var id int
		var lu, grp, nt string
		var w int
		if err := rows.Scan(&id, &lu, &w, &grp, &nt); err != nil {
			return rev, nil, err
		}
		out[strconv.Itoa(id)] = cellState{U: lu, W: w, Grp: grp, Nt: nt}
	}
	return rev, out, nil
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	rev, cells, err := s.loadState(id.Mode)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "cells": cells})
}

type updateReq struct {
	Op    string `json:"op"`  // setUse | clearUse | setWildlife | group | note | delete
	IDs   []int  `json:"ids"` // affected cells
	Value string `json:"value"`
	Flag  bool   `json:"flag"`
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	if len(req.IDs) == 0 {
		writeJSON(w, 400, map[string]string{"error": "no cells"})
		return
	}
	rev, err := s.nextRev()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	tx, err := s.DB.Begin()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer tx.Rollback()
	by := firstNonEmpty(id.Name, "Editor")
	mode := id.Mode
	for _, cid := range req.IDs {
		switch req.Op {
		case "setUse":
			_, err = tx.Exec(`INSERT INTO cells(cell_id,mode,land_use,rev,updated_by) VALUES(?,?,?,?,?)
				ON CONFLICT(mode,cell_id) DO UPDATE SET land_use=excluded.land_use,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, mode, req.Value, rev, by)
		case "clearUse":
			_, err = tx.Exec(`UPDATE cells SET land_use=NULL,rev=?,updated_by=? WHERE mode=? AND cell_id=?`, rev, by, mode, cid)
		case "setWildlife":
			fl := 0
			if req.Flag {
				fl = 1
			}
			_, err = tx.Exec(`INSERT INTO cells(cell_id,mode,wildlife,rev,updated_by) VALUES(?,?,?,?,?)
				ON CONFLICT(mode,cell_id) DO UPDATE SET wildlife=excluded.wildlife,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, mode, fl, rev, by)
		case "group":
			var grp interface{}
			if req.Value != "" {
				grp = req.Value
			}
			_, err = tx.Exec(`INSERT INTO cells(cell_id,mode,grp,rev,updated_by) VALUES(?,?,?,?,?)
				ON CONFLICT(mode,cell_id) DO UPDATE SET grp=excluded.grp,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, mode, grp, rev, by)
		case "note":
			var nt interface{}
			if req.Value != "" {
				nt = req.Value
			}
			_, err = tx.Exec(`INSERT INTO cells(cell_id,mode,note,rev,updated_by) VALUES(?,?,?,?,?)
				ON CONFLICT(mode,cell_id) DO UPDATE SET note=excluded.note,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, mode, nt, rev, by)
		case "delete":
			// clear everything for the cell
			_, err = tx.Exec(`UPDATE cells SET land_use=NULL,wildlife=0,grp=NULL,note=NULL,rev=?,updated_by=? WHERE mode=? AND cell_id=?`, rev, by, mode, cid)
		default:
			writeJSON(w, 400, map[string]string{"error": "unknown op"})
			return
		}
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	// return updated states for affected cells
	changed := map[string]cellState{}
	for _, cid := range req.IDs {
		var lu, grp, nt string
		var wl int
		err := s.DB.QueryRow("SELECT COALESCE(land_use,''),wildlife,COALESCE(grp,''),COALESCE(note,'') FROM cells WHERE mode=? AND cell_id=?", mode, cid).Scan(&lu, &wl, &grp, &nt)
		if err == nil {
			changed[strconv.Itoa(cid)] = cellState{U: lu, W: wl, Grp: grp, Nt: nt}
		} else {
			changed[strconv.Itoa(cid)] = cellState{}
		}
	}
	s.scheduleAutosave(firstNonEmpty(id.Name, "Editor"), id.Mode)
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "changed": changed})
}

// ---- versions ----

// handleViewSave persists the caller's current map view (centre + zoom) for
// their secret's map, so re-entering with that secret reopens where they left.
func (s *Server) handleViewSave(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	var body struct {
		Lat  float64 `json:"lat"`
		Lng  float64 `json:"lng"`
		Zoom float64 `json:"zoom"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	v, _ := json.Marshal(body)
	_ = s.setMeta("view:"+id.Mode, string(v))
	writeJSON(w, 200, map[string]string{"ok": "1"})
}

func (s *Server) handleVersionsList(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	// only show snapshots belonging to the caller's map (mode) — never another secret's.
	rows, err := s.DB.Query("SELECT token,name,COALESCE(author,''),COALESCE(kind,'named'),created_at FROM versions WHERE mode=? ORDER BY id DESC", id.Mode)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	var list []map[string]string
	for rows.Next() {
		var tok, name, auth, kind string
		var created time.Time
		_ = rows.Scan(&tok, &name, &auth, &kind, &created)
		list = append(list, map[string]string{"token": tok, "name": name, "author": auth, "kind": kind, "created": created.Format(time.RFC3339)})
	}
	writeJSON(w, 200, map[string]interface{}{"versions": list})
}

func (s *Server) handleVersionSave(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	var body struct{ Name string }
	_ = json.NewDecoder(r.Body).Decode(&body)
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "v" + time.Now().Format("2006-01-02 15:04")
	}
	_, cells, err := s.loadState(id.Mode)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	data, _ := json.Marshal(cells)
	tok := randToken(9)
	_, err = s.DB.Exec("INSERT INTO versions(token,name,author,data,kind,mode,view) VALUES(?,?,?,?,'named',?,?)", tok, name, firstNonEmpty(id.Name, "Editor"), string(data), id.Mode, metaOr(s, "view:"+id.Mode))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]string{"token": tok, "name": name})
}

// handleVersionRename gives a name to a version (e.g. an autosaved snapshot the
// user wants to keep / share). Naming an autosave promotes it to 'named' so it
// won't be pruned.
func (s *Server) handleVersionRename(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	tok := r.PathValue("token")
	var body struct{ Name string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		writeJSON(w, 400, map[string]string{"error": "name required"})
		return
	}
	res, err := s.DB.Exec("UPDATE versions SET name=?, kind='named' WHERE token=? AND mode=?", strings.TrimSpace(body.Name), tok, id.Mode)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	writeJSON(w, 200, map[string]string{"ok": "1", "name": strings.TrimSpace(body.Name)})
}

// autosaveSnapshot stores the current state as an automatic version. Keeps every
// reasonable snapshot: it skips saving when nothing changed since the last
// autosave, and prunes only old *auto* snapshots (named versions are kept).
func (s *Server) autosaveSnapshot(by, mode string) {
	if mode == "" {
		mode = modeBoma
	}
	_, cells, err := s.loadState(mode)
	if err != nil {
		return
	}
	data, _ := json.Marshal(cells)
	// dedupe against most recent autosave for THIS map
	var last string
	_ = s.DB.QueryRow("SELECT data FROM versions WHERE kind='auto' AND mode=? ORDER BY id DESC LIMIT 1", mode).Scan(&last)
	if last == string(data) {
		return
	}
	// Name the snapshot by what actually changed (the "edit event"), diffing
	// against the previous autosave — e.g. "Cattle grazing +8 · Hunting −3".
	// This makes the history list meaningful and self-grouping.
	var prev map[string]cellState
	if last != "" {
		_ = json.Unmarshal([]byte(last), &prev)
	}
	name := summarizeEdit(prev, cells)
	tok := randToken(9)
	if _, err := s.DB.Exec("INSERT INTO versions(token,name,author,data,kind,mode,view) VALUES(?,?,?,?,'auto',?,?)", tok, name, firstNonEmpty(by, "Editor"), string(data), mode, metaOr(s, "view:"+mode)); err != nil {
		return
	}
	// NB: we intentionally keep the FULL all-time autosave history (no pruning).
}

// summarizeEdit describes the change from prev->curr as a short, human label so
// each autosave reads as a meaningful edit event in the history list.
func summarizeEdit(prev, curr map[string]cellState) string {
	useDelta := map[string]int{} // label -> net cells gained(+)/lost(-)
	var wildOn, wildOff, grpChg, noteChg int
	seen := map[string]bool{}
	check := func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		p, q := prev[id], curr[id]
		if p.U != q.U {
			if p.U != "" {
				useDelta[lbl(p.U)]--
			}
			if q.U != "" {
				useDelta[lbl(q.U)]++
			}
		}
		if (p.W != 0) != (q.W != 0) {
			if q.W != 0 {
				wildOn++
			} else {
				wildOff++
			}
		}
		if p.Grp != q.Grp {
			grpChg++
		}
		if p.Nt != q.Nt {
			noteChg++
		}
	}
	for id := range curr {
		check(id)
	}
	for id := range prev {
		check(id)
	}
	var parts []string
	// stable order: follow the legend order, then anything else.
	order := []string{"settlement", "grazing", "hunting", "fishing", "farming", "wildlife"}
	emitted := map[string]bool{}
	emit := func(label string, n int) {
		if n == 0 || emitted[label] {
			return
		}
		emitted[label] = true
		sign := "+"
		if n < 0 {
			sign = "\u2212" // minus sign
			n = -n
		}
		parts = append(parts, label+" "+sign+strconv.Itoa(n))
	}
	for _, k := range order {
		emit(lbl(k), useDelta[lbl(k)])
	}
	for label, n := range useDelta {
		emit(label, n)
	}
	if wildOn > 0 {
		parts = append(parts, "Wildlife range +"+strconv.Itoa(wildOn))
	}
	if wildOff > 0 {
		parts = append(parts, "Wildlife range \u2212"+strconv.Itoa(wildOff))
	}
	if grpChg > 0 {
		parts = append(parts, "Grouping \u00d7"+strconv.Itoa(grpChg))
	}
	if noteChg > 0 {
		parts = append(parts, "Notes \u00d7"+strconv.Itoa(noteChg))
	}
	if len(parts) == 0 {
		return "Edit " + time.Now().Format("Jan 2 15:04")
	}
	// keep it short: at most 3 facets, then an ellipsis.
	if len(parts) > 3 {
		parts = append(parts[:3], "\u2026")
	}
	return strings.Join(parts, " \u00b7 ")
}

// lbl is useLabel with an id fallback (useLabel returns "" for unknown ids).
func lbl(id string) string {
	if l := useLabel(id); l != "" {
		return l
	}
	return id
}

func (s *Server) handleVersionGet(w http.ResponseWriter, r *http.Request) {
	// version snapshots are shareable; require auth still
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	tok := r.PathValue("token")
	var name, auth, data, view string
	var created time.Time
	err := s.DB.QueryRow("SELECT name,COALESCE(author,''),data,COALESCE(view,''),created_at FROM versions WHERE token=? AND mode=?", tok, id.Mode).Scan(&name, &auth, &data, &view, &created)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	var cells map[string]cellState
	_ = json.Unmarshal([]byte(data), &cells)
	out := map[string]interface{}{"name": name, "author": auth, "created": created.Format(time.RFC3339), "cells": cells}
	if view != "" {
		out["view"] = json.RawMessage(view)
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleVersionRestore(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	tok := r.PathValue("token")
	var data string
	// only restore a snapshot that belongs to the caller's map.
	if err := s.DB.QueryRow("SELECT data FROM versions WHERE token=? AND mode=?", tok, id.Mode).Scan(&data); err != nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	var cells map[string]cellState
	if err := json.Unmarshal([]byte(data), &cells); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if err := s.replaceAll(cells, firstNonEmpty(id.Name, "Editor"), id.Mode); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	rev, all, _ := s.loadState(id.Mode)
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "cells": all})
}

func (s *Server) replaceAll(cells map[string]cellState, by, mode string) error {
	rev, err := s.nextRev()
	if err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// only replace THIS map's cells — never touch another secret's data.
	if _, err := tx.Exec("DELETE FROM cells WHERE mode=?", mode); err != nil {
		return err
	}
	stmt, err := tx.Prepare("INSERT INTO cells(cell_id,mode,land_use,wildlife,grp,note,rev,updated_by) VALUES(?,?,?,?,?,?,?,?)")
	if err != nil {
		return err
	}
	for idStr, c := range cells {
		cid, err := strconv.Atoi(idStr)
		if err != nil {
			continue
		}
		var lu, grp, nt interface{}
		if c.U != "" {
			lu = c.U
		}
		if c.Grp != "" {
			grp = c.Grp
		}
		if c.Nt != "" {
			nt = c.Nt
		}
		if _, err := stmt.Exec(cid, mode, lu, c.W, grp, nt, rev, by); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ---- import / export ----

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	fmtq := r.URL.Query().Get("fmt")
	// Name the download (and the GeoPackage layer) after the version currently
	// being edited, sanitized to a safe base name.
	name := exportBaseName(r.URL.Query().Get("name"))
	_, cells, err := s.loadState(id.Mode)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	switch fmtq {
	case "gpkg", "geopackage":
		s.exportGeoPackage(w, cells, name)
	case "geojson":
		s.exportGeoJSON(w, cells, name)
	default:
		s.exportCSV(w, cells, name)
	}
}

// exportBaseName turns a (possibly empty/messy) version name into a safe base
// name usable for both a download filename and a SQL/layer identifier. Falls
// back to "landuse" when nothing usable remains.
func exportBaseName(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	// collapse runs of underscores
	for strings.Contains(out, "__") {
		out = strings.ReplaceAll(out, "__", "_")
	}
	if out == "" {
		return "landuse"
	}
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func (s *Server) exportCSV(w http.ResponseWriter, cells map[string]cellState, name string) {
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+".csv\"")
	fmt.Fprintln(w, "cell_id,lat,lon,land_use,land_use_label,wildlife,group,note,area_ha")
	for _, idn := range sortedCellIDs(cells) {
		c := cells[strconv.Itoa(idn)]
		lon, lat := gidCentroid(idn)
		fmt.Fprintf(w, "%d,%s,%s,%s,%s,%d,%s,%s,%.1f\n",
			idn,
			strconv.FormatFloat(lat, 'f', 6, 64),
			strconv.FormatFloat(lon, 'f', 6, 64),
			csvEsc(c.U), csvEsc(useLabel(c.U)), c.W,
			csvEsc(c.Grp), csvEsc(c.Nt), cellAreaHa(idn))
	}
}

func csvEsc(s string) string {
	if strings.ContainsAny(s, ",\"\n") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}

// exportGeoJSON builds polygons from the dynamic global lattice plus assignments.
func (s *Server) exportGeoJSON(w http.ResponseWriter, cells map[string]cellState, name string) {
	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+".geojson\"")
	w.Write([]byte(`{"type":"FeatureCollection","features":[`))
	first := true
	for _, id := range sortedCellIDs(cells) {
		st := cells[strconv.Itoa(id)]
		if !first {
			w.Write([]byte(","))
		}
		first = false
		ring := gidPolygon(id)
		coords := make([][]float64, len(ring))
		for i, p := range ring {
			coords[i] = []float64{p[0], p[1]}
		}
		lon, lat := gidCentroid(id)
		feat := map[string]interface{}{
			"type": "Feature",
			"geometry": map[string]interface{}{
				"type":        "Polygon",
				"coordinates": [][][]float64{coords},
			},
			"properties": map[string]interface{}{
				"cell_id": id, "land_use": st.U, "land_use_label": useLabel(st.U),
				"wildlife": st.W, "group": st.Grp, "note": st.Nt,
				"area_ha": cellAreaHa(id), "lon": lon, "lat": lat,
			},
		}
		jb, _ := json.Marshal(feat)
		w.Write(jb)
	}
	w.Write([]byte("]}"))
}

func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	var body struct {
		Format string               `json:"format"` // csv|geojson|gpkg
		Text   string               `json:"text"`   // raw text, or base64 for gpkg
		Cells  map[string]cellState `json:"cells"`
		Mode   string               `json:"mode"` // replace|merge
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	parsed := body.Cells
	if parsed == nil {
		parsed = map[string]cellState{}
	}
	if body.Format == "csv" && body.Text != "" {
		parsed = parseCSV(body.Text)
	}
	if body.Format == "geojson" && body.Text != "" {
		parsed = parseImportGeoJSON(body.Text)
	}
	if body.Format == "gpkg" && body.Text != "" {
		p, err := parseImportGeoPackage(body.Text)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad GeoPackage: " + err.Error()})
			return
		}
		parsed = p
	}
	if len(parsed) == 0 {
		writeJSON(w, 400, map[string]string{"error": "nothing to import"})
		return
	}
	by := firstNonEmpty(id.Name, "Editor")
	mode := id.Mode
	if body.Mode == "replace" {
		if err := s.replaceAll(parsed, by, mode); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
	} else {
		// merge
		rev, _ := s.nextRev()
		tx, _ := s.DB.Begin()
		defer tx.Rollback()
		stmt, _ := tx.Prepare(`INSERT INTO cells(cell_id,mode,land_use,wildlife,grp,note,rev,updated_by) VALUES(?,?,?,?,?,?,?,?)
			ON CONFLICT(mode,cell_id) DO UPDATE SET land_use=excluded.land_use,wildlife=excluded.wildlife,grp=excluded.grp,note=excluded.note,rev=excluded.rev,updated_by=excluded.updated_by`)
		for k, c := range parsed {
			cid, err := strconv.Atoi(k)
			if err != nil {
				continue
			}
			var lu, grp, nt interface{}
			if c.U != "" {
				lu = c.U
			}
			if c.Grp != "" {
				grp = c.Grp
			}
			if c.Nt != "" {
				nt = c.Nt
			}
			stmt.Exec(cid, mode, lu, c.W, grp, nt, rev, by)
		}
		tx.Commit()
	}
	rev, all, _ := s.loadState(mode)
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "cells": all, "imported": len(parsed)})
}

func parseCSV(text string) map[string]cellState {
	out := map[string]cellState{}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	// Column mapping by header name (robust to extra/reordered cols like lat/lon).
	// Falls back to legacy fixed order: cell_id,land_use,wildlife,group,note.
	col := map[string]int{"cell_id": 0, "land_use": 1, "wildlife": 2, "group": 3, "note": 4}
	hasHeader := false
	if len(lines) > 0 && strings.Contains(strings.ToLower(lines[0]), "cell_id") {
		hasHeader = true
		for i, h := range splitCSVLine(lines[0]) {
			col[strings.ToLower(strings.TrimSpace(h))] = i
		}
	}
	get := func(f []string, name string) string {
		idx, ok := col[name]
		if !ok || idx < 0 || idx >= len(f) {
			return ""
		}
		return f[idx]
	}
	for i, ln := range lines {
		if i == 0 && hasHeader {
			continue
		}
		if strings.TrimSpace(ln) == "" {
			continue
		}
		f := splitCSVLine(ln)
		if len(f) < 2 {
			continue
		}
		id, err := strconv.Atoi(strings.TrimSpace(get(f, "cell_id")))
		if err != nil {
			continue
		}
		cs := cellState{U: strings.TrimSpace(get(f, "land_use"))}
		if n, _ := strconv.Atoi(strings.TrimSpace(get(f, "wildlife"))); n == 1 {
			cs.W = 1
		}
		cs.Grp = get(f, "group")
		cs.Nt = get(f, "note")
		out[strconv.Itoa(id)] = cs
	}
	return out
}

func splitCSVLine(ln string) []string {
	var fields []string
	var cur strings.Builder
	inq := false
	for i := 0; i < len(ln); i++ {
		ch := ln[i]
		if inq {
			if ch == '"' {
				if i+1 < len(ln) && ln[i+1] == '"' {
					cur.WriteByte('"')
					i++
				} else {
					inq = false
				}
			} else {
				cur.WriteByte(ch)
			}
		} else {
			switch ch {
			case '"':
				inq = true
			case ',':
				fields = append(fields, cur.String())
				cur.Reset()
			default:
				cur.WriteByte(ch)
			}
		}
	}
	fields = append(fields, cur.String())
	return fields
}

func parseImportGeoJSON(text string) map[string]cellState {
	out := map[string]cellState{}
	var fc struct {
		Features []struct {
			Properties map[string]interface{} `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal([]byte(text), &fc); err != nil {
		return out
	}
	for _, f := range fc.Features {
		p := f.Properties
		idv, ok := p["cell_id"]
		if !ok {
			idv, ok = p["id"]
		}
		if !ok {
			continue
		}
		var id int
		switch t := idv.(type) {
		case float64:
			id = int(t)
		case string:
			id, _ = strconv.Atoi(t)
		}
		cs := cellState{}
		if v, ok := p["land_use"].(string); ok {
			cs.U = v
		}
		if v, ok := p["wildlife"].(float64); ok && v == 1 {
			cs.W = 1
		}
		if v, ok := p["group"].(string); ok {
			cs.Grp = v
		}
		if v, ok := p["note"].(string); ok {
			cs.Nt = v
		}
		out[strconv.Itoa(id)] = cs
	}
	return out
}
