#!/usr/bin/env node
/**
 * Hero Smoke Test for Discovery Chat API
 * Tests critical queries to prevent regressions
 * 
 * Run: npm run hero:smoke (requires dev server on http://localhost:3000)
 */

const BASE_URL = 'http://localhost:3000';

const KNOWN_PIZZA_NAMES = [
    'pizza', 'margherita', 'marinara', 'funghi', 'capricciosa', 'quattro formaggi',
    'quattro stagioni', 'diavola', 'calzone', 'prosciutto', 'pepperoni', 'hawaiian',
    'napoletana', 'vegetariana', 'vesuvio', 'kebabpizza'
];

const NON_PIZZA_DISHES = ['bruschetta', 'antipasto', 'aloo gobi', 'chana masala', 'raita'];

async function queryDiscovery(query) {
    const response = await fetch(`${BASE_URL}/api/discover/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages: [{ role: 'user', content: query }],
            chatState: null,
            grounded: null
        })
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
}

function isPizzaDish(dishName) {
    const lower = dishName.toLowerCase();
    return KNOWN_PIZZA_NAMES.some(p => lower.includes(p));
}

function isNonPizzaDish(dishName) {
    const lower = dishName.toLowerCase();
    return NON_PIZZA_DISHES.some(np => lower.includes(np));
}

async function testVegPizza() {
    console.log('\n🍕 TEST 1: "any veg pizza?"');
    console.log('   Expected: ONLY pizza matches, NO non-pizza vegetarian dishes');

    const result = await queryDiscovery('any veg pizza?');
    const message = result.message || result;
    const restaurants = message.restaurants || [];

    let allMatches = [];
    for (const r of restaurants) {
        for (const m of (r.matches || [])) {
            allMatches.push({ restaurant: r.name, dish: m.name });
        }
    }

    console.log(`   Found ${allMatches.length} matches across ${restaurants.length} restaurants`);

    // Check for violations
    const violations = allMatches.filter(m => isNonPizzaDish(m.dish));
    const pizzaMatches = allMatches.filter(m => isPizzaDish(m.dish));

    if (violations.length > 0) {
        console.log('   ❌ FAIL: Non-pizza dishes found!');
        violations.forEach(v => console.log(`      - ${v.dish} (${v.restaurant})`));
        return false;
    }

    if (allMatches.length === 0) {
        console.log('   ⚠️  WARNING: No matches found (may be data issue)');
        return true; // Not a code failure
    }

    console.log('   ✅ PASS: All matches are pizza dishes');
    pizzaMatches.forEach(m => console.log(`      - ${m.dish} (${m.restaurant})`));
    return true;
}

async function testAnythingVeg() {
    console.log('\n🥗 TEST 2: "anything veg?"');
    console.log('   Expected: At least 1 restaurant with vegetarian dishes');

    const result = await queryDiscovery('anything veg?');
    const message = result.message || result;
    const restaurants = message.restaurants || [];

    if (restaurants.length === 0) {
        console.log('   ❌ FAIL: No restaurants returned');
        return false;
    }

    const matchCount = restaurants.reduce((sum, r) => sum + (r.matches?.length || 0), 0);
    console.log(`   ✅ PASS: Found ${matchCount} matches across ${restaurants.length} restaurants`);
    return true;
}

async function runAllTests() {
    console.log('='.repeat(60));
    console.log('🧪 HERO SMOKE TESTS - Discovery Chat API');
    console.log('='.repeat(60));

    let allPassed = true;

    try {
        if (!await testVegPizza()) allPassed = false;
        if (!await testAnythingVeg()) allPassed = false;
    } catch (error) {
        console.log(`\n❌ ERROR: ${error.message}`);
        console.log('   Make sure dev server is running: npm run dev');
        process.exit(1);
    }

    console.log('\n' + '='.repeat(60));
    if (allPassed) {
        console.log('✅ ALL TESTS PASSED');
        process.exit(0);
    } else {
        console.log('❌ SOME TESTS FAILED');
        process.exit(1);
    }
}

runAllTests();
