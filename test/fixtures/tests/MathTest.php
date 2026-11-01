<?php
namespace Tests;

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

final class MathTest extends TestCase
{
    public function testAdds(): void
    {
        $this->assertSame(2, 1 + 1);
    }

    #[Test]
    public function subtracts(): void
    {
        $this->assertSame(1, 3 - 1, 'three minus one');
    }

    public static function numbers(): array
    {
        return [[1], [2]];
    }

    #[DataProvider('numbers')]
    public function testParam(int $n): void
    {
        $this->assertGreaterThan(0, $n);
    }

    public function testLater(): void
    {
        $this->markTestSkipped('later');
    }
}
