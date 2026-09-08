#include "AutoRouter.h"
#include <math.h>
#include <stdlib.h>
#include <stdint.h>

typedef struct {
    size_t *nodes, *positions;
    size_t count;
    double *priority;
} Heap;

static int less(const Heap *heap, size_t a, size_t b) {
    return heap->priority[a] < heap->priority[b]
        || (heap->priority[a] == heap->priority[b] && a < b);
}
static void swap(Heap *heap, size_t a, size_t b) {
    size_t t = heap->nodes[a];
    heap->nodes[a] = heap->nodes[b]; heap->nodes[b] = t;
    heap->positions[heap->nodes[a]] = a;
    heap->positions[heap->nodes[b]] = b;
}
static void decrease(Heap *heap, size_t node) {
    size_t at = heap->positions[node];
    if (at == SIZE_MAX) {
        at = heap->count++;
        heap->nodes[at] = node;
        heap->positions[node] = at;
    }
    while (at > 0) {
        size_t parent = (at - 1) / 2;
        if (!less(heap, heap->nodes[at], heap->nodes[parent])) break;
        swap(heap, at, parent); at = parent;
    }
}
static size_t pop(Heap *heap) {
    size_t result = heap->nodes[0];
    heap->positions[result] = SIZE_MAX;
    --heap->count;
    if (heap->count > 0) {
        heap->nodes[0] = heap->nodes[heap->count];
        heap->positions[heap->nodes[0]] = 0;
        size_t at = 0;
        while (at * 2 + 1 < heap->count) {
            size_t child = at * 2 + 1;
            if (child + 1 < heap->count && less(heap, heap->nodes[child + 1], heap->nodes[child])) ++child;
            if (!less(heap, heap->nodes[child], heap->nodes[at])) break;
            swap(heap, child, at); at = child;
        }
    }
    return result;
}
static int nonnegative(double value) { return isfinite(value) && value >= 0; }
static double heuristic(size_t node, size_t goal, size_t columns) {
    return hypot((double)(node / columns) - (double)(goal / columns),
                 (double)(node % columns) - (double)(goal % columns));
}

DRResult dr_plan(const DRGrid *grid, const DRVessel *vessel,
                 size_t start, size_t goal, size_t *path, size_t capacity) {
    DRResult result = { DR_INVALID_INPUT, 0, NAN };
    if (!grid || !vessel || !path || !capacity || !grid->rows || !grid->columns
        || grid->rows > 1000000 || grid->columns > 1000000 / grid->rows
        || !isfinite(grid->cell_size_m) || grid->cell_size_m <= 0
        || grid->cell_size_m > 1000000
        || !grid->charted_depth_m || !grid->depth_uncertainty_m || !grid->flags
        || !isfinite(vessel->draft_m) || vessel->draft_m <= 0
        || !nonnegative(vessel->under_keel_clearance_m)
        || !nonnegative(vessel->dynamic_allowance_m)
        || !nonnegative(vessel->horizontal_buffer_m)
        || !isfinite(vessel->water_level_lower_m)) return result;
    size_t rows = grid->rows, columns = grid->columns, count = rows * columns;
    if (start >= count || goal >= count) return result;
    double required = vessel->draft_m + vessel->under_keel_clearance_m + vessel->dynamic_allowance_m;
    double radius_value = ceil(vessel->horizontal_buffer_m / grid->cell_size_m);
    if (!isfinite(required) || !isfinite(radius_value)) return result;
    if (radius_value >= (double)rows || radius_value >= (double)columns) {
        result.status = DR_START_BLOCKED; return result;
    }
    size_t radius = (size_t)radius_value, stride = columns + 1;
    uint32_t *prefix = calloc((rows + 1) * stride, sizeof(*prefix));
    uint8_t *pass = calloc(count, sizeof(*pass));
    uint8_t *closed = calloc(count, sizeof(*closed));
    double *cost = malloc(count * sizeof(*cost));
    double *priority = malloc(count * sizeof(*priority));
    size_t *parents = malloc(count * sizeof(*parents));
    size_t *nodes = malloc(count * sizeof(*nodes));
    size_t *positions = malloc(count * sizeof(*positions));
    if (!prefix || !pass || !closed || !cost || !priority || !parents || !nodes || !positions) {
        result.status = DR_NO_MEMORY; goto cleanup;
    }

    for (size_t r = 0; r < rows; ++r) {
        for (size_t c = 0; c < columns; ++c) {
            size_t i = r * columns + c;
            double depth = grid->charted_depth_m[i], uncertainty = grid->depth_uncertainty_m[i];
            double available = depth + vessel->water_level_lower_m - uncertainty;
            int valid = grid->flags[i] == DR_COVERED && isfinite(depth)
                && nonnegative(uncertainty) && isfinite(available) && available >= required;
            prefix[(r + 1) * stride + c + 1] = (uint32_t)!valid
                + prefix[r * stride + c + 1] + prefix[(r + 1) * stride + c] - prefix[r * stride + c];
            cost[i] = INFINITY; priority[i] = INFINITY;
            parents[i] = SIZE_MAX; positions[i] = SIZE_MAX;
        }
    }
    for (size_t r = 0; r < rows; ++r) {
        for (size_t c = 0; c < columns; ++c) {
            if (r < radius || c < radius || r + radius >= rows || c + radius >= columns) continue;
            size_t r0 = r - radius, c0 = c - radius;
            size_t r1 = r + radius + 1, c1 = c + radius + 1;
            uint32_t blocked = prefix[r1 * stride + c1] - prefix[r0 * stride + c1]
                - prefix[r1 * stride + c0] + prefix[r0 * stride + c0];
            pass[r * columns + c] = blocked == 0;
        }
    }
    if (!pass[start]) { result.status = DR_START_BLOCKED; goto cleanup; }
    if (!pass[goal]) { result.status = DR_GOAL_BLOCKED; goto cleanup; }

    Heap heap = { nodes, positions, 0, priority };
    cost[start] = 0; priority[start] = heuristic(start, goal, columns);
    decrease(&heap, start);
    result.status = DR_NO_ROUTE;
    while (heap.count > 0) {
        size_t current = pop(&heap);
        if (current == goal) {
            size_t length = 1;
            for (size_t at = goal; at != start; at = parents[at]) ++length;
            result.count = length;
            if (length > capacity) { result.status = DR_OUTPUT_TOO_SMALL; goto cleanup; }
            size_t at = goal;
            for (size_t j = length; j > 0; --j) { path[j - 1] = at; at = parents[at]; }
            result.distance_m = cost[goal] * grid->cell_size_m;
            result.status = DR_OK;
            goto cleanup;
        }
        closed[current] = 1;
        long row = (long)(current / columns), column = (long)(current % columns);
        for (long dy = -1; dy <= 1; ++dy) {
            for (long dx = -1; dx <= 1; ++dx) {
                if (dx == 0 && dy == 0) continue;
                long nr = row + dy, nc = column + dx;
                if (nr < 0 || nc < 0 || nr >= (long)rows || nc >= (long)columns) continue;
                size_t next = (size_t)nr * columns + (size_t)nc;
                if (!pass[next] || closed[next]) continue;
                if (dx && dy && (!pass[(size_t)row * columns + (size_t)nc]
                                || !pass[(size_t)nr * columns + (size_t)column])) continue;
                double tentative = cost[current] + (dx && dy ? sqrt(2.0) : 1.0);
                if (tentative < cost[next]) {
                    cost[next] = tentative; parents[next] = current;
                    priority[next] = tentative + heuristic(next, goal, columns);
                    decrease(&heap, next);
                }
            }
        }
    }
cleanup:
    free(prefix); free(pass); free(closed); free(cost); free(priority);
    free(parents); free(nodes); free(positions);
    return result;
}
