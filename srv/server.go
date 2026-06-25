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
	"sort"
	"strconv"
	"strings"
	"time"

	"srv.exe.dev/db"
)

type Server struct {
	DB        *sql.DB
	Hostname  string
	StaticDir string
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
	stmt, err := tx.Prepare("INSERT INTO cells(cell_id,land_use,wildlife,rev,updated_by) VALUES(?,?,?,?,'seed') ON CONFLICT(cell_id) DO NOTHING")
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

type identity struct {
	OwnerEmail string
	Email      string // exe.dev email of requester
	Name       string // editor name (from cookie)
	IsOwner    bool
	Authed     bool // has valid editor session OR is owner
}

func (s *Server) secret() string {
	v, _ := s.getMeta("secret")
	return v
}

func (s *Server) sign(name string) string {
	mac := hmac.New(sha256.New, []byte(s.secret()))
	mac.Write([]byte(name))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) makeCookieValue(name string) string {
	enc := base64.RawURLEncoding.EncodeToString([]byte(name))
	return enc + "." + s.sign(name)
}

func (s *Server) parseCookieValue(val string) (string, bool) {
	parts := strings.SplitN(val, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	nb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	name := string(nb)
	if hmac.Equal([]byte(s.sign(name)), []byte(parts[1])) {
		return name, true
	}
	return "", false
}

func (s *Server) identify(r *http.Request) identity {
	id := identity{}
	id.OwnerEmail, _ = s.getMeta("owner_email")
	id.Email = strings.TrimSpace(r.Header.Get("X-ExeDev-Email"))
	if id.OwnerEmail != "" && id.Email != "" && strings.EqualFold(id.Email, id.OwnerEmail) {
		id.IsOwner = true
		id.Authed = true
	}
	if c, err := r.Cookie("lu_session"); err == nil && s.secret() != "" {
		if name, ok := s.parseCookieValue(c.Value); ok {
			id.Name = name
			id.Authed = true
		}
	}
	if id.IsOwner && id.Name == "" {
		// derive a friendly owner name
		id.Name = "Owner"
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
	mux.HandleFunc("POST /api/setup", s.handleSetup)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	mux.HandleFunc("POST /api/reset-secret", s.handleResetSecret)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("POST /api/update", s.handleUpdate)
	mux.HandleFunc("GET /api/versions", s.handleVersionsList)
	mux.HandleFunc("POST /api/versions", s.handleVersionSave)
	mux.HandleFunc("GET /api/versions/{token}", s.handleVersionGet)
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
	hasSecret := s.secret() != ""
	writeJSON(w, 200, map[string]interface{}{
		"authed":    id.Authed,
		"owner":     id.IsOwner,
		"name":      id.Name,
		"hasSecret": hasSecret,
		"email":     id.Email,
		"title":     firstNonEmpty(metaOr(s, "title"), "Land Use Zonation"),
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

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if s.secret() != "" {
		writeJSON(w, 409, map[string]string{"error": "already configured"})
		return
	}
	id := s.identify(r)
	// If an owner email is already designated, only that owner may run setup.
	if owner, ok := s.getMeta("owner_email"); ok && owner != "" {
		if id.Email != "" && !strings.EqualFold(id.Email, owner) {
			writeJSON(w, 403, map[string]string{"error": "only the owner can set this up"})
			return
		}
	}
	var body struct{ Secret, Name, Title string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Secret) == "" {
		writeJSON(w, 400, map[string]string{"error": "secret required"})
		return
	}
	_ = s.setMeta("secret", body.Secret)
	if id.Email != "" {
		_ = s.setMeta("owner_email", id.Email)
	}
	if body.Title != "" {
		_ = s.setMeta("title", body.Title)
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "Owner"
	}
	s.setSessionCookie(w, name)
	writeJSON(w, 200, map[string]string{"ok": "1", "name": name})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct{ Secret, Name string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	if s.secret() == "" {
		writeJSON(w, 409, map[string]string{"error": "not configured"})
		return
	}
	if subtleCompare(body.Secret, s.secret()) != true {
		writeJSON(w, 403, map[string]string{"error": "wrong secret"})
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = randomEditorName()
	}
	s.setSessionCookie(w, name)
	writeJSON(w, 200, map[string]string{"ok": "1", "name": name})
}

func subtleCompare(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}

func (s *Server) setSessionCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "lu_session",
		Value:    s.makeCookieValue(name),
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

func (s *Server) handleResetSecret(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.IsOwner {
		writeJSON(w, 403, map[string]string{"error": "owner only"})
		return
	}
	var body struct{ Secret string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Secret) == "" {
		writeJSON(w, 400, map[string]string{"error": "secret required"})
		return
	}
	_ = s.setMeta("secret", body.Secret)
	s.setSessionCookie(w, firstNonEmpty(id.Name, "Owner"))
	writeJSON(w, 200, map[string]string{"ok": "1"})
}

// ---- state & updates ----

type cellState struct {
	U   string `json:"u,omitempty"`
	W   int    `json:"w,omitempty"`
	Grp string `json:"grp,omitempty"`
	Nt  string `json:"nt,omitempty"`
}

func (s *Server) loadState() (int64, map[string]cellState, error) {
	var rev int64
	_ = s.DB.QueryRow("SELECT CAST(value AS INTEGER) FROM meta WHERE key='rev'").Scan(&rev)
	rows, err := s.DB.Query("SELECT cell_id, COALESCE(land_use,''), wildlife, COALESCE(grp,''), COALESCE(note,'') FROM cells WHERE land_use IS NOT NULL OR wildlife=1 OR grp IS NOT NULL OR note IS NOT NULL")
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
	rev, cells, err := s.loadState()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "cells": cells})
}

type updateReq struct {
	Op    string `json:"op"`   // setUse | clearUse | setWildlife | group | note | delete
	IDs   []int  `json:"ids"`  // affected cells
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
	for _, cid := range req.IDs {
		switch req.Op {
		case "setUse":
			_, err = tx.Exec(`INSERT INTO cells(cell_id,land_use,rev,updated_by) VALUES(?,?,?,?)
				ON CONFLICT(cell_id) DO UPDATE SET land_use=excluded.land_use,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, req.Value, rev, by)
		case "clearUse":
			_, err = tx.Exec(`UPDATE cells SET land_use=NULL,rev=?,updated_by=? WHERE cell_id=?`, rev, by, cid)
		case "setWildlife":
			fl := 0
			if req.Flag {
				fl = 1
			}
			_, err = tx.Exec(`INSERT INTO cells(cell_id,wildlife,rev,updated_by) VALUES(?,?,?,?)
				ON CONFLICT(cell_id) DO UPDATE SET wildlife=excluded.wildlife,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, fl, rev, by)
		case "group":
			var grp interface{}
			if req.Value != "" {
				grp = req.Value
			}
			_, err = tx.Exec(`INSERT INTO cells(cell_id,grp,rev,updated_by) VALUES(?,?,?,?)
				ON CONFLICT(cell_id) DO UPDATE SET grp=excluded.grp,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, grp, rev, by)
		case "note":
			var nt interface{}
			if req.Value != "" {
				nt = req.Value
			}
			_, err = tx.Exec(`INSERT INTO cells(cell_id,note,rev,updated_by) VALUES(?,?,?,?)
				ON CONFLICT(cell_id) DO UPDATE SET note=excluded.note,rev=excluded.rev,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`,
				cid, nt, rev, by)
		case "delete":
			// clear everything for the cell
			_, err = tx.Exec(`UPDATE cells SET land_use=NULL,wildlife=0,grp=NULL,note=NULL,rev=?,updated_by=? WHERE cell_id=?`, rev, by, cid)
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
		err := s.DB.QueryRow("SELECT COALESCE(land_use,''),wildlife,COALESCE(grp,''),COALESCE(note,'') FROM cells WHERE cell_id=?", cid).Scan(&lu, &wl, &grp, &nt)
		if err == nil {
			changed[strconv.Itoa(cid)] = cellState{U: lu, W: wl, Grp: grp, Nt: nt}
		} else {
			changed[strconv.Itoa(cid)] = cellState{}
		}
	}
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "changed": changed})
}

// ---- versions ----

func (s *Server) handleVersionsList(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	rows, err := s.DB.Query("SELECT token,name,COALESCE(author,''),created_at FROM versions ORDER BY id DESC")
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()
	var list []map[string]string
	for rows.Next() {
		var tok, name, auth string
		var created time.Time
		_ = rows.Scan(&tok, &name, &auth, &created)
		list = append(list, map[string]string{"token": tok, "name": name, "author": auth, "created": created.Format(time.RFC3339)})
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
	_, cells, err := s.loadState()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	data, _ := json.Marshal(cells)
	tok := randToken(9)
	_, err = s.DB.Exec("INSERT INTO versions(token,name,author,data) VALUES(?,?,?,?)", tok, name, firstNonEmpty(id.Name, "Editor"), string(data))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]string{"token": tok, "name": name})
}

func (s *Server) handleVersionGet(w http.ResponseWriter, r *http.Request) {
	// version snapshots are shareable; require auth still
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	tok := r.PathValue("token")
	var name, auth, data string
	var created time.Time
	err := s.DB.QueryRow("SELECT name,COALESCE(author,''),data,created_at FROM versions WHERE token=?", tok).Scan(&name, &auth, &data, &created)
	if err != nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	var cells map[string]cellState
	_ = json.Unmarshal([]byte(data), &cells)
	writeJSON(w, 200, map[string]interface{}{"name": name, "author": auth, "created": created.Format(time.RFC3339), "cells": cells})
}

func (s *Server) handleVersionRestore(w http.ResponseWriter, r *http.Request) {
	id := s.identify(r)
	if !id.Authed {
		writeJSON(w, 401, map[string]string{"error": "auth required"})
		return
	}
	tok := r.PathValue("token")
	var data string
	if err := s.DB.QueryRow("SELECT data FROM versions WHERE token=?", tok).Scan(&data); err != nil {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	var cells map[string]cellState
	if err := json.Unmarshal([]byte(data), &cells); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	if err := s.replaceAll(cells, firstNonEmpty(id.Name, "Editor")); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	rev, all, _ := s.loadState()
	writeJSON(w, 200, map[string]interface{}{"rev": rev, "cells": all})
}

func (s *Server) replaceAll(cells map[string]cellState, by string) error {
	rev, err := s.nextRev()
	if err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM cells"); err != nil {
		return err
	}
	stmt, err := tx.Prepare("INSERT INTO cells(cell_id,land_use,wildlife,grp,note,rev,updated_by) VALUES(?,?,?,?,?,?,?)")
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
		if _, err := stmt.Exec(cid, lu, c.W, grp, nt, rev, by); err != nil {
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
	_, cells, err := s.loadState()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	switch fmtq {
	case "geojson":
		s.exportGeoJSON(w, cells)
	default:
		s.exportCSV(w, cells)
	}
}

func (s *Server) exportCSV(w http.ResponseWriter, cells map[string]cellState) {
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=\"landuse.csv\"")
	centroids := s.cellCentroids() // id -> [lon,lat]
	fmt.Fprintln(w, "cell_id,lat,lon,land_use,wildlife,group,note")
	ids := make([]int, 0, len(cells))
	for k := range cells {
		n, _ := strconv.Atoi(k)
		ids = append(ids, n)
	}
	sort.Ints(ids)
	for _, idn := range ids {
		c := cells[strconv.Itoa(idn)]
		var lat, lon string
		if ct, ok := centroids[idn]; ok && len(ct) == 2 {
			lon = strconv.FormatFloat(ct[0], 'f', 6, 64)
			lat = strconv.FormatFloat(ct[1], 'f', 6, 64)
		}
		fmt.Fprintf(w, "%d,%s,%s,%s,%d,%s,%s\n", idn, lat, lon, csvEsc(c.U), c.W, csvEsc(c.Grp), csvEsc(c.Nt))
	}
}

// cellCentroids loads each grid cell's centroid ([lon,lat]) from the static grid.
func (s *Server) cellCentroids() map[int][]float64 {
	out := map[int][]float64{}
	gb, err := readFile(filepath.Join(s.StaticDir, "data", "grid.json"))
	if err != nil {
		return out
	}
	var grid struct {
		Cells []struct {
			ID int       `json:"id"`
			Ct []float64 `json:"ct"`
		} `json:"cells"`
	}
	if json.Unmarshal(gb, &grid) != nil {
		return out
	}
	for _, c := range grid.Cells {
		out[c.ID] = c.Ct
	}
	return out
}

func csvEsc(s string) string {
	if strings.ContainsAny(s, ",\"\n") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}

// exportGeoJSON builds polygons from the static grid plus assignments.
func (s *Server) exportGeoJSON(w http.ResponseWriter, cells map[string]cellState) {
	gb, err := readFile(filepath.Join(s.StaticDir, "data", "grid.json"))
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "grid missing"})
		return
	}
	var grid struct {
		Cells []struct {
			ID int         `json:"id"`
			G  [][]float64 `json:"g"`
		} `json:"cells"`
	}
	if err := json.Unmarshal(gb, &grid); err != nil {
		writeJSON(w, 500, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/geo+json")
	w.Header().Set("Content-Disposition", "attachment; filename=\"landuse.geojson\"")
	w.Write([]byte(`{"type":"FeatureCollection","features":[`))
	first := true
	for _, c := range grid.Cells {
		st, ok := cells[strconv.Itoa(c.ID)]
		if !ok {
			continue
		}
		if !first {
			w.Write([]byte(","))
		}
		first = false
		ring := make([][]float64, 0, len(c.G)+1)
		ring = append(ring, c.G...)
		if len(c.G) > 0 {
			ring = append(ring, c.G[0])
		}
		feat := map[string]interface{}{
			"type": "Feature",
			"geometry": map[string]interface{}{
				"type":        "Polygon",
				"coordinates": [][][]float64{ring},
			},
			"properties": map[string]interface{}{
				"cell_id": c.ID, "land_use": st.U, "wildlife": st.W, "group": st.Grp, "note": st.Nt,
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
		Format string                `json:"format"` // csv|geojson
		Text   string                `json:"text"`
		Cells  map[string]cellState  `json:"cells"`
		Mode   string                `json:"mode"` // replace|merge
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
	if len(parsed) == 0 {
		writeJSON(w, 400, map[string]string{"error": "nothing to import"})
		return
	}
	by := firstNonEmpty(id.Name, "Editor")
	if body.Mode == "replace" {
		if err := s.replaceAll(parsed, by); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
	} else {
		// merge
		rev, _ := s.nextRev()
		tx, _ := s.DB.Begin()
		defer tx.Rollback()
		stmt, _ := tx.Prepare(`INSERT INTO cells(cell_id,land_use,wildlife,grp,note,rev,updated_by) VALUES(?,?,?,?,?,?,?)
			ON CONFLICT(cell_id) DO UPDATE SET land_use=excluded.land_use,wildlife=excluded.wildlife,grp=excluded.grp,note=excluded.note,rev=excluded.rev,updated_by=excluded.updated_by`)
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
			stmt.Exec(cid, lu, c.W, grp, nt, rev, by)
		}
		tx.Commit()
	}
	rev, all, _ := s.loadState()
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
