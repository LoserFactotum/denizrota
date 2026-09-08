#include "AutoRouter.h"
#include "NavigationMath.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

enum { SIDE = 7, CELLS = SIDE * SIDE };
static double depths[CELLS], uncertainty[CELLS];
static uint8_t flags[CELLS];
static size_t path[CELLS];
static int checks;
static DRGrid grid = { SIDE, SIDE, 10, depths, uncertainty, flags };
static DRVessel boat = { 1, 0.5, 0, 0, 0 };

static void reset(void) {
    for (int i = 0; i < CELLS; ++i) {
        depths[i] = 10; uncertainty[i] = 0; flags[i] = DR_COVERED; path[i] = SIZE_MAX;
    }
    boat = (DRVessel){ 1, 0.5, 0, 0, 0 };
}
static DRResult run(size_t start, size_t goal) {
    return dr_plan(&grid, &boat, start, goal, path, CELLS);
}
static void status(DRResult result, DRStatus expected) {
    ++checks; assert(result.status == expected);
    if (expected != DR_OK) { ++checks; assert(isnan(result.distance_m)); }
}
static void near(double a, double b) { ++checks; assert(isfinite(a) && fabs(a - b) < 1e-7); }

/* O(V^2) Dijkstra oracle, independent of the A* heap. Random cases use only
 * coverage flags, uniformly deep water and no buffer. */
static double reference(size_t start, size_t goal) {
    double distance[CELLS]; int visited[CELLS] = {0};
    if (flags[start] != DR_COVERED || flags[goal] != DR_COVERED) return INFINITY;
    for (int i = 0; i < CELLS; ++i) distance[i] = INFINITY;
    distance[start] = 0;
    for (int iteration = 0; iteration < CELLS; ++iteration) {
        int current = -1;
        for (int i = 0; i < CELLS; ++i)
            if (!visited[i] && (current < 0 || distance[i] < distance[current])) current = i;
        if (current < 0 || !isfinite(distance[current])) break;
        visited[current] = 1;
        for (int next = 0; next < CELLS; ++next) {
            int dr = abs(next / SIDE - current / SIDE), dc = abs(next % SIDE - current % SIDE);
            if ((dr == 0 && dc == 0) || dr > 1 || dc > 1 || flags[next] != DR_COVERED) continue;
            if (dr && dc && (flags[current / SIDE * SIDE + next % SIDE] != DR_COVERED
                || flags[next / SIDE * SIDE + current % SIDE] != DR_COVERED)) continue;
            double value = distance[current] + hypot(dr, dc) * grid.cell_size_m;
            if (value < distance[next]) distance[next] = value;
        }
    }
    return distance[goal];
}

int main(void) {
    reset();
    DRResult straight = run(21, 27);
    status(straight, DR_OK); near(straight.distance_m, 60);
    ++checks; assert(path[0] == 21 && path[straight.count - 1] == 27);
    near(dn_eta_seconds(straight.distance_m, dn_mps_from_knots(6)), 60.0 / 1852.0 / 6.0 * 3600.0);
    flags[24] = DR_COVERED | DR_LAND;
    DRResult detour = run(21, 27);
    status(detour, DR_OK); ++checks; assert(detour.distance_m > straight.distance_m);
    for (size_t i = 0; i < detour.count; ++i) { ++checks; assert(path[i] != 24); }

    /* The shallow passage closes as draft, uncertainty or allowance increase. */
    reset();
    for (int r = 0; r < SIDE - 1; ++r) depths[r * SIDE + 3] = 2;
    DRResult shallowBoat = run(21, 27); status(shallowBoat, DR_OK); near(shallowBoat.distance_m, 60);
    boat.draft_m = 2;
    DRResult deepBoat = run(21, 27); status(deepBoat, DR_OK);
    ++checks; assert(deepBoat.distance_m > shallowBoat.distance_m);
    boat.water_level_lower_m = 1;
    status(run(21, 27), DR_OK); near(run(21, 27).distance_m, 60);
    boat = (DRVessel){ 1, 0.5, 0, -1, 0 };
    near(run(21, 27).distance_m, deepBoat.distance_m);
    boat = (DRVessel){ 1, 0.5, 1, 0, 0 };
    near(run(21, 27).distance_m, deepBoat.distance_m);
    boat.dynamic_allowance_m = 0;
    for (int r = 0; r < SIDE - 1; ++r) uncertainty[r * SIDE + 3] = 0.6;
    near(run(21, 27).distance_m, deepBoat.distance_m);

    /* Gaps and closed barriers must not cause a direct-line fallback. */
    reset();
    for (int r = 0; r < SIDE; ++r) flags[r * SIDE + 3] = 0;
    status(run(21, 27), DR_NO_ROUTE);
    for (int r = 0; r < SIDE; ++r) flags[r * SIDE + 3] = DR_COVERED | DR_RESTRICTED;
    status(run(21, 27), DR_NO_ROUTE);
    for (int r = 0; r < SIDE; ++r) flags[r * SIDE + 3] = DR_COVERED | DR_OBSTACLE;
    status(run(21, 27), DR_NO_ROUTE);
    reset();
    for (int r = 0; r < SIDE; ++r) depths[r * SIDE + 3] = NAN;
    status(run(21, 27), DR_NO_ROUTE);
    reset();
    for (int r = 0; r < SIDE; ++r) uncertainty[r * SIDE + 3] = NAN;
    status(run(21, 27), DR_NO_ROUTE);
    reset();
    flags[1] = DR_LAND; flags[SIDE] = DR_LAND;
    status(run(0, 8), DR_NO_ROUTE);
    flags[0] = DR_LAND;
    status(run(0, 8), DR_START_BLOCKED);
    reset(); flags[8] = DR_LAND; status(run(0, 8), DR_GOAL_BLOCKED);

    /* Horizontal margins include edges; endpoints are never moved silently. */
    reset(); flags[24] = DR_OBSTACLE;
    DRResult unbuffered = run(22, 26); status(unbuffered, DR_OK);
    boat.horizontal_buffer_m = 10;
    DRResult buffered = run(22, 26); status(buffered, DR_OK);
    ++checks; assert(buffered.distance_m > unbuffered.distance_m);
    for (size_t i = 0; i < buffered.count; ++i) {
        int r = (int)(path[i] / SIDE), c = (int)(path[i] % SIDE);
        ++checks; assert(r >= 1 && c >= 1 && r < 6 && c < 6);
        ++checks; assert(abs(r - 3) > 1 || abs(c - 3) > 1);
    }
    status(run(21, 27), DR_START_BLOCKED);
    boat.horizontal_buffer_m = 100; status(run(22, 26), DR_START_BLOCKED);

    reset(); status(run(24, 24), DR_OK); near(run(24, 24).distance_m, 0);
    path[0] = SIZE_MAX;
    DRResult shortOutput = dr_plan(&grid, &boat, 21, 27, path, 1);
    status(shortOutput, DR_OUTPUT_TOO_SMALL);
    ++checks; assert(shortOutput.count > 1 && path[0] == SIZE_MAX);
    boat.draft_m = NAN; status(run(21, 27), DR_INVALID_INPUT);
    reset(); boat.draft_m = 0; status(run(21, 27), DR_INVALID_INPUT);
    reset(); boat.horizontal_buffer_m = -1; status(run(21, 27), DR_INVALID_INPUT);
    reset(); status(run(CELLS, 0), DR_INVALID_INPUT);
    DRGrid invalid = grid; invalid.rows = SIZE_MAX;
    status(dr_plan(&invalid, &boat, 0, 1, path, CELLS), DR_INVALID_INPUT);

    uint32_t seed = 4179;
    for (int scenario = 0; scenario < 300; ++scenario) {
        reset();
        for (int i = 0; i < CELLS; ++i) {
            seed = seed * 1664525u + 1013904223u;
            flags[i] = (seed >> 16) % 100 < 30 ? DR_LAND : DR_COVERED;
        }
        flags[0] = flags[CELLS - 1] = DR_COVERED;
        double expected = reference(0, CELLS - 1);
        DRResult result = run(0, CELLS - 1);
        if (!isfinite(expected)) { status(result, DR_NO_ROUTE); continue; }
        status(result, DR_OK); near(result.distance_m, expected);
        double length = 0;
        ++checks; assert(path[0] == 0 && path[result.count - 1] == CELLS - 1);
        for (size_t j = 0; j < result.count; ++j) {
            ++checks; assert(path[j] < CELLS && flags[path[j]] == DR_COVERED);
            if (j == 0) continue;
            int r0 = (int)(path[j - 1] / SIDE), c0 = (int)(path[j - 1] % SIDE);
            int r1 = (int)(path[j] / SIDE), c1 = (int)(path[j] % SIDE);
            int dr = abs(r1 - r0), dc = abs(c1 - c0);
            ++checks; assert(dr <= 1 && dc <= 1 && dr + dc > 0);
            if (dr && dc) {
                ++checks; assert(flags[r0 * SIDE + c1] == DR_COVERED && flags[r1 * SIDE + c0] == DR_COVERED);
            }
            length += hypot(dr, dc) * grid.cell_size_m;
        }
        near(length, result.distance_m);
    }
    printf("PASS: %d automatic-routing checks (synthetic grids; 300 Dijkstra comparisons)\n", checks);
    return 0;
}
