using Xunit;

namespace Shop.Tests;

public class CartTests
{
    [Fact]
    public void Adds()
    {
        Assert.Equal(2, 1 + 1);
    }

    [Fact]
    public void Subtracts()
    {
        Assert.Equal(1, 3 - 1);
    }

    [Theory]
    [InlineData(2)]
    public void Param(int n) => Assert.True(n > 0);

    [Fact(Skip = "later")]
    public async Task Later()
    {
        await Task.Yield();
    }
}
