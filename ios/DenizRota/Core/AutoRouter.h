#ifndef DENIZ_ROTA_AUTO_ROUTER_H
#define DENIZ_ROTA_AUTO_ROUTER_H
#include <stddef.h>
#include <stdint.h>

/* Development engine; not a chart source or an operational navigation system.
 * The adapter must conservatively cover the ENTIRE area of each metric grid
 * cell, including charted hazards and source-quality gaps. No interpolation of
 * unknown cells into supposedly safe water is permitted by this contract.
 * Local, square projected cells; index = row * columns + column.
 * Results join CELL CENTRES and are not automatically joined to arbitrary GPS
 * endpoints. Such connector segments require separate coverage validation. */
enum {
    DR_COVERED = 1,
    DR_LAND = 2,
    DR_OBSTACLE = 4,
    DR_RESTRICTED = 8
};
typedef struct {
    size_t rows, columns;
    double cell_size_m;
    const double *charted_depth_m;       /* Positive below declared chart datum. */
    const double *depth_uncertainty_m;   /* Nonnegative; unknown => NAN. */
    const uint8_t *flags;                /* Only DR_COVERED alone is traversable. */
} DRGrid;
typedef struct {
    double draft_m;
    double under_keel_clearance_m;
    double dynamic_allowance_m;    /* E.g. externally established squat/wave allowance. */
    double water_level_lower_m;    /* Conservative lower level, SAME datum as chart. */
    double horizontal_buffer_m;   /* Includes vessel footprint and horizontal uncertainties. */
} DRVessel;
typedef enum {
    DR_OK = 0,
    DR_INVALID_INPUT,
    DR_NO_MEMORY,
    DR_START_BLOCKED,
    DR_GOAL_BLOCKED,
    DR_NO_ROUTE,
    DR_OUTPUT_TOO_SMALL
} DRStatus;
typedef struct {
    DRStatus status;
    size_t count;                  /* Needed capacity if output is too small. */
    double distance_m;             /* NAN unless status == DR_OK. */
} DRResult;

/* A* on 8-connected cells, no diagonal corner cutting. A positive horizontal
 * buffer conservatively expands blocked areas by a square of ceil(buffer/cell)
 * cells. Out-of-coverage is treated as blocked. Never snaps endpoints, fills
 * data gaps, relaxes clearance, or returns a direct-line fallback on failure.
 * Arrays must each contain rows*columns elements, max 1,000,000 cells.
 * path is caller-owned; no partial path is written on failure. */
DRResult dr_plan(const DRGrid *grid, const DRVessel *vessel,
                 size_t start, size_t goal, size_t *path, size_t capacity);
#endif
