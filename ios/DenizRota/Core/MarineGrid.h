#ifndef MARINE_GRID_H
#define MARINE_GRID_H
#include <stddef.h>
#include <stdint.h>

/* Numeric, north-up EPSG:4326 raster. Values retain the source sign. */
typedef struct {
    size_t rows, columns;
    double west, north, dx, dy;
    double *values;
} DMRaster;
/* Classic single-band GeoTIFF; signed integer or float, strips or tiles,
   uncompressed/Deflate. Unsupported encodings are rejected, never rendered
   into RGB and interpreted as depths. 0 success; nonzero malformed/unsupported. */
int dm_read_geotiff(const uint8_t *bytes, size_t length, DMRaster *out);
void dm_free_raster(DMRaster *raster);
/* Shallowest depth of ALL source pixels intersecting a rectangle.
   WCS emodnet:mean uses elevations: depth = -elevation. NAN if any missing. */
double dm_min_depth(const DMRaster *raster, double west, double south,
                    double east, double north);

typedef struct { double x, y; } DMPoint;
typedef struct { DMPoint a, b; } DMSegment;
/* Metric local plane. Origin is grid's southwest corner; row 0 is north.
   Coastlines are directed with land on the left (OSM convention).
   Output: 0 unknown, 1 water, 2 land, 4 coast/obstacle. */
int dm_coast_mask(size_t rows, size_t cols, double cell,
                  const DMSegment *coast, size_t count, uint8_t *mask);
void dm_block_shape(size_t rows, size_t cols, double cell,
                     const DMPoint *points, size_t count, int fill, uint8_t *mask);
/* Clamps no coordinates: an endpoint outside the grid is an error. */
int dm_cell_index(size_t rows, size_t cols, double cell, DMPoint p, size_t *index);
#endif
