package srv

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
)

// ---- global hex lattice: must match srv/static/app.js exactly ----
const (
	dLon = 0.0260618 // column pitch (deg lon)
	dLat = 0.0298990 // row pitch (deg lat)
)

// landUse is the shared palette (mirrors USES in app.js).
type landUse struct{ ID, Label, Color string }

var landUses = []landUse{
	{"settlement", "Permanent settlements", "#cccccc"},
	{"grazing", "Cattle grazing", "#8db05c"},
	{"hunting", "Hunting", "#d89146"},
	{"fishing", "Fishing", "#08a3e6"},
	{"farming", "Farming", "#f1ef62"},
	{"wildlife", "Wildlife / occasional", "#dfe7c1"},
}

func useLabel(id string) string {
	for _, u := range landUses {
		if u.ID == id {
			return u.Label
		}
	}
	return ""
}

// ungid -> (row,col); mirrors ungid() in app.js.
func ungid(id int) (r, c int) {
	r = (id % 40000) - 16384
	c = (id / 40000) - 16384
	return
}

// gidCentroid returns [lon,lat] of a cell id; mirrors gidCentroid() in app.js.
func gidCentroid(id int) (lon, lat float64) {
	r, c := ungid(id)
	shift := 0.0
	if c&1 != 0 {
		shift = dLat / 2
	}
	lon = float64(c) * dLon
	lat = -(float64(r) * dLat) - shift
	return
}

// gidPolygon returns the closed hexagon ring [[lon,lat],...] for a cell id.
// Mirrors the hex vertex math in genGrid() in app.js.
func gidPolygon(id int) [][2]float64 {
	x, y := gidCentroid(id)
	R := dLon / 1.5
	halfR := R / 2
	halfH := dLat / 2
	pts := [][2]float64{
		{x - R, y}, {x - halfR, y + halfH}, {x + halfR, y + halfH},
		{x + R, y}, {x + halfR, y - halfH}, {x - halfR, y - halfH},
	}
	pts = append(pts, pts[0]) // close ring
	return pts
}

// cellAreaHa approximates a cell's area in hectares at its latitude
// (same pitch-rectangle estimate the UI shows in the tooltip).
func cellAreaHa(id int) float64 {
	_, lat := gidCentroid(id)
	km2 := (dLon * 111.320 * math.Cos(lat*math.Pi/180)) * (dLat * 110.574)
	return km2 * 100
}

// sortedCellIDs returns the populated cell ids in ascending order.
func sortedCellIDs(cells map[string]cellState) []int {
	ids := make([]int, 0, len(cells))
	for k := range cells {
		n, _ := strconv.Atoi(k)
		ids = append(ids, n)
	}
	sort.Ints(ids)
	return ids
}

// ---- GeoPackage (OGC) writer: a GeoPackage is a SQLite DB with the OGC schema ----

func (s *Server) exportGeoPackage(w http.ResponseWriter, cells map[string]cellState) {
	f, err := os.CreateTemp("", "landuse-*.gpkg")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	path := f.Name()
	f.Close()
	defer os.Remove(path)

	if err := buildGeoPackage(path, cells); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/geopackage+sqlite3")
	w.Header().Set("Content-Disposition", `attachment; filename="landuse.gpkg"`)
	w.Write(data)
}

func buildGeoPackage(path string, cells map[string]cellState) error {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()

	const table = "land_use"
	stmts := []string{
		`PRAGMA application_id = 1196444487;`, // 'GPKG'
		`PRAGMA user_version = 10300;`,
		`CREATE TABLE gpkg_spatial_ref_sys (
			srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY,
			organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
			definition TEXT NOT NULL, description TEXT);`,
		`CREATE TABLE gpkg_contents (
			table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE,
			description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);`,
		`CREATE TABLE gpkg_geometry_columns (
			table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
			srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL,
			CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));`,
		`CREATE TABLE "` + table + `" (
			fid INTEGER PRIMARY KEY AUTOINCREMENT,
			geom BLOB,
			cell_id INTEGER, land_use TEXT, land_use_label TEXT,
			wildlife INTEGER, "group" TEXT, note TEXT,
			area_ha REAL, lon REAL, lat REAL);`,
		`CREATE TABLE layer_styles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			f_table_catalog TEXT, f_table_schema TEXT, f_table_name TEXT,
			f_geometry_column TEXT, styleName TEXT, styleQML TEXT, styleSLD TEXT,
			useAsDefault BOOLEAN, description TEXT, owner TEXT, ui TEXT,
			update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
	}

	// WGS84 + the two required default SRS rows.
	srs := []struct {
		name string
		id   int
		org  string
		ocid int
		def  string
	}{
		{"Undefined cartesian SRS", -1, "NONE", -1, "undefined"},
		{"Undefined geographic SRS", 0, "NONE", 0, "undefined"},
		{"WGS 84 geodetic", 4326, "EPSG", 4326, `GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]`},
	}
	for _, r := range srs {
		if _, err := db.Exec(`INSERT INTO gpkg_spatial_ref_sys(srs_name,srs_id,organization,organization_coordsys_id,definition) VALUES(?,?,?,?,?)`,
			r.name, r.id, r.org, r.ocid, r.def); err != nil {
			return err
		}
	}

	ids := sortedCellIDs(cells)
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	ins, err := tx.Prepare(`INSERT INTO "` + table + `"(geom,cell_id,land_use,land_use_label,wildlife,"group",note,area_ha,lon,lat) VALUES(?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	for _, id := range ids {
		st := cells[strconv.Itoa(id)]
		ring := gidPolygon(id)
		blob := gpkgPolygon(ring)
		for _, p := range ring {
			minX, maxX = math.Min(minX, p[0]), math.Max(maxX, p[0])
			minY, maxY = math.Min(minY, p[1]), math.Max(maxY, p[1])
		}
		lon, lat := gidCentroid(id)
		if _, err := ins.Exec(blob, id, st.U, useLabel(st.U), st.W, st.Grp, st.Nt,
			cellAreaHa(id), lon, lat); err != nil {
			tx.Rollback()
			return err
		}
	}
	ins.Close()
	if err := tx.Commit(); err != nil {
		return err
	}
	if math.IsInf(minX, 1) { // no rows
		minX, minY, maxX, maxY = 0, 0, 0, 0
	}

	if _, err := db.Exec(`INSERT INTO gpkg_contents(table_name,data_type,identifier,description,min_x,min_y,max_x,max_y,srs_id)
		VALUES(?, 'features', ?, 'Land use zonation (10 km² hex grid)', ?,?,?,?, 4326)`,
		table, table, minX, minY, maxX, maxY); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO gpkg_geometry_columns(table_name,column_name,geometry_type_name,srs_id,z,m)
		VALUES(?, 'geom', 'POLYGON', 4326, 0, 0)`, table); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO layer_styles
		(f_table_catalog,f_table_schema,f_table_name,f_geometry_column,styleName,styleQML,styleSLD,useAsDefault,description,owner,ui)
		VALUES('','', ?, 'geom', 'land_use', ?, '', 1, 'Categorized by land use', '', '')`,
		table, styleQML()); err != nil {
		return err
	}
	return nil
}

// gpkgPolygon encodes a single-ring polygon as a GeoPackage geometry blob
// (GP header + little-endian WKB), SRS 4326.
func gpkgPolygon(ring [][2]float64) []byte {
	var b bytes.Buffer
	// --- GeoPackage binary header ---
	b.WriteByte('G')
	b.WriteByte('P')
	b.WriteByte(0)    // version 0
	b.WriteByte(0x01) // flags: little-endian, no envelope
	binary.Write(&b, binary.LittleEndian, int32(4326))
	// --- WKB Polygon ---
	b.WriteByte(0x01)                                // little-endian
	binary.Write(&b, binary.LittleEndian, uint32(3)) // Polygon
	binary.Write(&b, binary.LittleEndian, uint32(1)) // 1 ring
	binary.Write(&b, binary.LittleEndian, uint32(len(ring)))
	for _, p := range ring {
		binary.Write(&b, binary.LittleEndian, p[0])
		binary.Write(&b, binary.LittleEndian, p[1])
	}
	return b.Bytes()
}

// styleQML builds a QGIS categorized-renderer style keyed on land_use,
// so the layer opens already coloured to match the web app.
func styleQML() string {
	var cats, syms bytes.Buffer
	for i, u := range landUses {
		r, g, bl := hexRGB(u.Color)
		fmt.Fprintf(&cats, `<category render="true" value="%s" symbol="%d" label="%s"/>`,
			u.ID, i, u.Label)
		fmt.Fprintf(&syms, `<symbol type="fill" name="%d"><layer class="SimpleFill">`+
			`<prop k="color" v="%d,%d,%d,200"/>`+
			`<prop k="outline_color" v="120,120,110,180"/>`+
			`<prop k="outline_width" v="0.12"/>`+
			`<prop k="style" v="solid"/></layer></symbol>`, i, r, g, bl)
	}
	// trailing "unassigned" symbol
	fmt.Fprintf(&syms, `<symbol type="fill" name="%d"><layer class="SimpleFill">`+
		`<prop k="color" v="240,240,240,120"/><prop k="outline_color" v="180,180,180,180"/>`+
		`<prop k="outline_width" v="0.1"/><prop k="style" v="solid"/></layer></symbol>`, len(landUses))
	return `<!DOCTYPE qgis><qgis version="3.0"><renderer-v2 type="categorizedSymbol" attr="land_use" forceraster="0" symbollevels="0">` +
		`<categories>` + cats.String() +
		fmt.Sprintf(`<category render="true" value="" symbol="%d" label="Unassigned"/>`, len(landUses)) +
		`</categories><symbols>` + syms.String() + `</symbols></renderer-v2></qgis>`
}

func hexRGB(h string) (int, int, int) {
	if len(h) == 7 && h[0] == '#' {
		r, _ := strconv.ParseInt(h[1:3], 16, 0)
		g, _ := strconv.ParseInt(h[3:5], 16, 0)
		b, _ := strconv.ParseInt(h[5:7], 16, 0)
		return int(r), int(g), int(b)
	}
	return 187, 187, 187
}

// parseImportGeoPackage reads a base64-encoded GeoPackage and pulls cell
// assignments back out. It is tolerant of our own export and of GeoPackages
// round-tripped through QGIS (column names may be lower-cased / reordered),
// keying strictly on the cell_id attribute (geometry is ignored on import).
func parseImportGeoPackage(b64 string) (map[string]cellState, error) {
	// allow an optional data-URL prefix the browser may add
	if i := strings.Index(b64, ","); i >= 0 && strings.HasPrefix(b64, "data:") {
		b64 = b64[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("not valid base64")
	}
	f, err := os.CreateTemp("", "import-*.gpkg")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	f.Write(raw)
	f.Close()
	defer os.Remove(path)

	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	// Find a feature table that carries a cell_id column. Prefer our own
	// "land_use" table, else scan gpkg_contents for feature tables.
	tables := []string{}
	if rows, err := db.Query(`SELECT table_name FROM gpkg_contents WHERE data_type='features'`); err == nil {
		for rows.Next() {
			var t string
			rows.Scan(&t)
			tables = append(tables, t)
		}
		rows.Close()
	}
	if len(tables) == 0 {
		tables = []string{"land_use"}
	}

	out := map[string]cellState{}
	for _, t := range tables {
		cols := tableColumns(db, t)
		if _, ok := cols["cell_id"]; !ok {
			continue
		}
		// build a SELECT that tolerates missing optional columns
		q := fmt.Sprintf(`SELECT cell_id, %s, %s, %s, %s FROM "%s"`,
			coalesceText(cols, "land_use"),
			coalesceInt(cols, "wildlife"),
			coalesceText(cols, "group"),
			coalesceText(cols, "note"), t)
		rows, err := db.Query(q)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id int
			var lu, grp, nt string
			var w int
			if err := rows.Scan(&id, &lu, &w, &grp, &nt); err != nil {
				continue
			}
			cs := cellState{U: strings.TrimSpace(lu), Grp: grp, Nt: nt}
			if w == 1 {
				cs.W = 1
			}
			out[strconv.Itoa(id)] = cs
		}
		rows.Close()
		if len(out) > 0 {
			break
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no land_use features with a cell_id column")
	}
	return out, nil
}

// tableColumns returns the lower-cased set of column names for a table.
func tableColumns(db *sql.DB, table string) map[string]bool {
	out := map[string]bool{}
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info("%s")`, table))
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt interface{}
		if rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk) == nil {
			out[strings.ToLower(name)] = true
		}
	}
	return out
}

func coalesceText(cols map[string]bool, name string) string {
	if cols[name] {
		return `COALESCE("` + name + `",'')`
	}
	return `''`
}
func coalesceInt(cols map[string]bool, name string) string {
	if cols[name] {
		return `COALESCE("` + name + `",0)`
	}
	return `0`
}
